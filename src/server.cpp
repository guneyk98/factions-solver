#include <httplib.h>

#include <atomic>
#include <charconv>
#include <chrono>
#include <csignal>
#include <expected>
#include <filesystem>
#include <format>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <system_error>

namespace {

/* systemd reads whatever a service writes to stdout and stderr, and reads a
   <N> at the start of a line as the syslog priority, so each line lands in the
   journal at its own level and `journalctl -p warning` picks out the ones that
   matter. The journal stamps and names every line itself, so neither the time
   nor the unit belongs here. */
enum class Level {
    Error = 3,
    Warning = 4,
    Info = 6,
};

void say(Level level, std::string_view line)
{
    /* Flushed a line at a time: stdout to a pipe is block-buffered, so a
       service stopped between flushes would lose whatever it had not written,
       which is exactly the part explaining why it stopped. */
    std::ostream& to = level <= Level::Warning ? std::cerr : std::cout;
    to << '<' << static_cast<int>(level) << '>' << line << '\n'
       << std::flush;
}

struct Settings {
    std::string host = "0.0.0.0";
    int port = 8080;
};

std::expected<Settings, std::string> parse(int argc, char** argv)
{
    Settings settings;
    bool ported = false;

    for (int at = 1; at < argc; ++at) {
        const std::string_view arg = argv[at];

        if (arg == "--host") {
            if (at + 1 >= argc)
                return std::unexpected{"--host needs an address after it"};

            settings.host = argv[++at];
            if (settings.host.empty())
                return std::unexpected{"--host was given an empty address"};
            continue;
        }

        if (arg.starts_with('-'))
            return std::unexpected{std::format("unknown option '{}'", arg)};
        if (ported)
            return std::unexpected{std::format("only one port can be listened on, got '{}' as well", arg)};

        /* The whole argument has to be the number: '8080x' is a mistake worth
           reporting rather than a port to bind. */
        const auto* const last = arg.data() + arg.size();
        const auto [read, trouble] = std::from_chars(arg.data(), last, settings.port);
        if (trouble != std::errc{} || read != last || settings.port <= 0 || settings.port > 65535)
            return std::unexpected{std::format("'{}' is not a port between 1 and 65535", arg)};
        ported = true;
    }

    return settings;
}

/* The site directory sits beside the executable, as tools/package.sh lays it
   out, so it is resolved from argv[0] rather than from the working directory.
   An executable found on PATH has no directory component in argv[0], so that
   case falls back to the working directory. */
std::filesystem::path siteBesideTheProgram(const char* program)
{
    const std::filesystem::path self{program};
    return self.has_parent_path() ? self.parent_path() / "site" : std::filesystem::path{"site"};
}

/* The client address. Behind a proxy every connection originates at the
   proxy, so the socket address is the proxy's and the client's is in
   X-Forwarded-For. A proxy appends the address it observed to whatever the
   client sent, so the last entry is the only one a client cannot forge. The
   header is trusted only for loopback connections, which is where the proxy
   runs; from anywhere else it is client-supplied text. */
std::string cameFrom(const httplib::Request& request)
{
    const bool fromThisMachine = request.remote_addr == "127.0.0.1" || request.remote_addr == "::1";

    if (fromThisMachine && request.has_header("X-Forwarded-For")) {
        const std::string forwarded = request.get_header_value("X-Forwarded-For");
        const std::size_t comma = forwarded.find_last_of(',');

        std::string_view seen{forwarded};
        if (comma != std::string::npos)
            seen.remove_prefix(comma + 1);

        while (!seen.empty() && (seen.front() == ' ' || seen.front() == '\t'))
            seen.remove_prefix(1);
        while (!seen.empty() && (seen.back() == ' ' || seen.back() == '\t'))
            seen.remove_suffix(1);

        if (!seen.empty())
            return std::string{seen};
    }

    return request.remote_addr.empty() ? "-" : request.remote_addr;
}

/* Control bytes written as \xNN. httplib percent-decodes the path before this
   sees it, so a request for `/%0A<6>...` would otherwise put a real newline
   into the logged line, and since each line is read from the front for a
   <N> priority, a client could forge journal entries at a level of its
   choosing. Everything below 0x20 and DEL is escaped so one request stays one
   line. */
std::string oneLine(std::string_view text)
{
    std::string out;
    out.reserve(text.size());
    for (const unsigned char byte : text) {
        if (byte < 0x20 || byte == 0x7f)
            std::format_to(std::back_inserter(out), "\\x{:02x}", byte);
        else
            out += static_cast<char>(byte);
    }
    return out;
}

// The request target, query string included, since it distinguishes requests
// that share a path. params_to_query_str re-encodes the query, so only the
// decoded path can carry a control byte into the log.
std::string target(const httplib::Request& request)
{
    const std::string path = oneLine(request.path);
    return request.params.empty() ? path : path + '?' + httplib::detail::params_to_query_str(request.params);
}

// A static file is streamed rather than buffered in the body, so its size is
// the announced Content-Length.
std::string sent(const httplib::Response& response)
{
    if (!response.body.empty())
        return std::to_string(response.body.size());

    const std::string announced = response.get_header_value("Content-Length");
    return announced.empty() ? "0" : announced;
}

/* On SIGINT or SIGTERM, close the listening socket rather than wait to be
   killed. httplib is stopped from another thread by design, which is what the
   handler does; it touches nothing else. */
std::atomic<httplib::Server*> running{nullptr};

void stopOnSignal(int)
{
    if (httplib::Server* const server = running.load(); server != nullptr)
        server->stop();
}

thread_local std::chrono::steady_clock::time_point began;

} // namespace

// Serves the static site beside the executable. Everything is computed in the
// browser, so there is no api here; put a proxy in front for TLS.
int main(int argc, char** argv)
{
    const auto settings = parse(argc, argv);
    if (!settings) {
        std::cerr << settings.error() << '\n'
                  << "usage: " << argv[0] << " [port] [--host <address>]\n"
                  << "  --host  the address to bind, 0.0.0.0 by default; 127.0.0.1 to\n"
                  << "          accept loopback connections only, e.g. from a proxy\n";
        return 1;
    }

    const std::filesystem::path site = siteBesideTheProgram(argv[0]);
    if (!std::filesystem::is_directory(site)) {
        say(Level::Error, std::format("no site to serve at {}", site.string()));
        return 1;
    }

    httplib::Server svr;
    svr.set_mount_point("/", site.string());
    svr.set_post_routing_handler([](const httplib::Request&, httplib::Response& res) {
        if (!res.has_header("Cache-Control"))
            res.set_header("Cache-Control", "no-cache");
    });

    // Request start time, per connection thread, for the duration below.
    svr.set_pre_routing_handler([](const httplib::Request&, httplib::Response&) {
        began = std::chrono::steady_clock::now();
        return httplib::Server::HandlerResponse::Unhandled;
    });

    /* One line per request: client, method, target, status, bytes and
       duration. A 4xx logs as a warning and a 5xx as an error, so the journal
       can be filtered to either. */
    svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
        const Level level = res.status >= 500   ? Level::Error
                            : res.status >= 400 ? Level::Warning
                                                : Level::Info;

        const auto took = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - began
        );

        say(level, std::format("{} {} {} {} {} bytes in {:.1f} ms", cameFrom(req), req.method, target(req), res.status, sent(res), took.count()));
    });

    svr.set_exception_handler([](const httplib::Request& req, httplib::Response& res,
                                 const std::exception_ptr& raised) {
        std::string what = "something not derived from std::exception";
        try {
            std::rethrow_exception(raised);
        } catch (const std::exception& error) {
            what = error.what();
        } catch (...) { // NOLINT: what stays as it is
        }

        say(Level::Error, std::format("{} {} threw: {}", req.method, target(req), what));
        res.status = 500;
    });

    running.store(&svr);
    for (const int signal : {SIGINT, SIGTERM})
        std::signal(signal, stopOnSignal);

    say(Level::Info, std::format("serving {} on {}:{}", site.string(), settings->host, settings->port));

    if (!svr.listen(settings->host, settings->port)) {
        say(Level::Error, std::format("cannot bind {}:{}", settings->host, settings->port));
        return 1;
    }

    say(Level::Info, "stopped");
    return 0;
}
