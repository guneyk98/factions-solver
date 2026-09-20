/* A command-line front end for the engine. Every mode prints one deterministic
   block, or '!' and a message if the engine rejected its input, so the whole
   surface can be diffed against the recorded answers in tests/expected. */

#include <algorithm>
#include <chrono>
#include <format>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

#include "parse.hpp"
#include "json.hpp"
#include "effects.hpp"
#include "game.hpp"
#include "simulate.hpp"
#include "solver.hpp"
#include "village.hpp"

using namespace Factions;

namespace {

int reject(const std::string& message)
{
    std::cout << '!' << message << '\n';
    return 0; // a rejection is a recorded outcome, not a failure to run
}

std::string slurp(const char* path)
{
    std::ifstream file{path};
    if (!file)
        return {};
    return std::string{std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
}

int production(const std::string& text)
{
    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    ProductionDetail detail;
    AuraDetail auras;
    const Rules& rules = Rules::of(parsed->game);
    const Output output = runEffects(rules, parsed->modifiers, parsed->village, &detail, &auras);
    std::cout << Json::of(output, detail, auras, rules.game(), parsed->village, parsed->season) << '\n';
    return 0;
}

// The village the text describes, in the form the page reads back. See Json::of.
int parsed(const std::string& text)
{
    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    std::cout << Json::of(parsed->village) << '\n';
    return 0;
}

int goals(std::string_view spec)
{
    const auto parsed = Parse::goals(spec);
    if (!parsed)
        return reject(parsed.error().message);

    std::cout << "ranking=" << (parsed->ranking == Ranking::WeightedSum ? "blended" : parsed->ranking == Ranking::Ratio ? "ratio" : "in-order") << '\n';
    for (const Goal& goal : parsed->goals)
        std::cout << "goal " << goal.objective->id << " weight=" << goal.weight << " atLeast=" << goal.atLeast << '\n';
    return 0;
}

int effort(std::string_view spec)
{
    const auto limits = Parse::effort(spec);
    if (!limits)
        return reject(limits.error().message);

    std::cout << "restarts=" << limits->restarts
              << " iterations=" << limits->iterations
              << " improvementPasses=" << limits->improvementPasses
              << " budget=" << limits->budget
              << " first=" << limits->firstRestart
              << " count=" << limits->restartCount
              << " terraform=" << limits->terraform << '\n';
    return 0;
}

/* Every modifier the api knows, and a check that its two views agree: all()
   generates the ids, find() parses them back, and each must resolve to a
   distinct field holding the neutral value all() reports. */
int modifiers()
{
    const std::vector<ModifierIds::Described> every = ModifierIds::all();

    GameModifiers fresh{};
    std::vector<const double*> seen;

    for (const ModifierIds::Described& one : every) {
        const std::optional<ModifierIds::Found> found = ModifierIds::find(fresh, one.id);
        if (!found)
            return reject(std::format("all() offers '{}' but find() does not know it", one.id));
        if (found->neutral != one.neutral || found->minimum != one.minimum)
            return reject(std::format("'{}' is described differently by all() and find()", one.id));
        if (*found->at != one.neutral)
            return reject(std::format("'{}' does not start at its neutral of {}", one.id, one.neutral));
        if (std::ranges::contains(seen, found->at))
            return reject(std::format("'{}' shares a field with an earlier modifier", one.id));

        seen.push_back(found->at);
        std::cout << one.id << " neutral=" << one.neutral << " minimum=" << one.minimum << '\n';
    }

    std::cout << every.size() << " modifiers\n";
    return 0;
}

// Times each stage of a request, so claims about where the time goes can be
// checked against measurements.
int bench(const std::string& text)
{
    using Clock = std::chrono::steady_clock;

    /* Every run must return a value, accumulated into a volatile, or -O3
       eliminates the work being timed. */
    static volatile double sink = 0;

    const auto time = [](std::string_view what, int runs, auto&& work) {
        const auto start = Clock::now();
        double keep = 0;
        for (int i = 0; i < runs; ++i)
            keep += work();
        sink = sink + keep;

        const double us = std::chrono::duration<double, std::micro>(Clock::now() - start).count() / runs;
        std::cout << std::format("{:<34} {:9.3f} us\n", what, us);
        return us;
    };

    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    ProductionDetail detail;

    const double parsing = time("parseRequest (101 tokens)", 2000, [&] {
        const auto r = Parse::village(text);
        return r ? r->village[0].level : -1;
    });
    const Rules& rules = Rules::of(parsed->game);

    const double bare = time("runEffects", 20000, [&] {
        return runEffects(rules, parsed->modifiers, parsed->village).production[Resource::Wood];
    });
    time("runEffects + per-tile detail", 20000, [&] {
        return runEffects(rules, parsed->modifiers, parsed->village, &detail).production[Resource::Wood];
    });

    AuraDetail auras;
    const Output out = runEffects(rules, parsed->modifiers, parsed->village, &detail, &auras);

    std::size_t bytes = 0;
    time("toJson: village only (parse reply)", 2000, [&] {
        const std::string text = Json::of(parsed->village);
        bytes = text.size();
        return static_cast<double>(bytes);
    });
    std::cout << "   (" << bytes << " bytes)\n";

    const double json = time("toJson (1500 doubles)", 2000, [&] {
        const std::string text = Json::of(out, detail, auras, rules.game(), parsed->village, parsed->season);
        bytes = text.size();
        return static_cast<double>(bytes);
    });
    std::cout << "   (" << bytes << " bytes)\n";

    std::cout << std::format("\nparse is {:.1f}x the cost of one runEffects,\n"
                             "and {:.0f}% of a whole production round trip\n",
                             parsing / bare, 100.0 * parsing / (parsing + bare + json));

    std::cout << std::format("\nsizeof Village {} B, ProductionDetail {} B\n", sizeof(Village), sizeof(ProductionDetail));

    // The per-arrangement cost the search pays before any arithmetic.
    Village working;
    const Village source = parsed->village;
    time("copy a Village", 200000, [&] {
        working = source;
        return working[0].level;
    });

    const auto goals = Parse::goals("wood.production");
    const std::span<const Goal> span{goals->goals};
    for (const long long budget : {10000LL, 100000LL}) {
        /* budget and iterations are per restart: divided so the whole run
           evaluates `budget` arrangements, iterations clearing the budget so a
           restart ends on the budget rather than on the step count. */
        constexpr int restarts = 64;

        SearchLimits limits;
        limits.restarts = restarts;
        limits.budget = budget / restarts;
        limits.iterations = static_cast<int>(limits.budget);

        const auto start = Clock::now();
        const SearchResult found = rearrange(parsed->modifiers, parsed->village, span, Ranking::Lexicographic, limits, parsed->game);
        const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();

        std::cout << std::format("\nsearch of {} arrangements: {:.1f} ms, one parse of {:.3f} ms is {:.4f}% of it\n", found.evaluated, ms, parsing / 1000.0, 100.0 * (parsing / 1000.0) / ms);
    }
    return 0;
}

/* Every game the engine carries, and what it makes of each one's rules. The
   unmodelled count is effects the api describes that this engine ignores. */
int games()
{
    for (const Game::Config& g : Game::all()) {
        int effects = 0;
        std::vector<std::string> ignored;
        for (const Game::Building& b : g.buildings)
            for (const Game::Effect& e : b.effects) {
                ++effects;
                if (!Game::modelled(e.quantity))
                    ignored.push_back(std::format("{}.{}", b.name, Game::name(e.quantity)));
            }

        std::ranges::sort(ignored);
        std::cout << std::format("{:4} {:16} {}x{} {} buildings, {} effects, {} unmodelled\n", g.id, g.map, g.width, g.height, g.buildings.size(), effects, ignored.size());
        for (const std::string& one : ignored)
            std::cout << "       " << one << '\n';
    }
    return 0;
}

int rearranged(const std::string& text, std::string_view goal, std::string_view spec)
{
    const auto wanted = Parse::goals(goal);
    if (!wanted)
        return reject(wanted.error().message);

    const auto limits = Parse::effort(spec);
    if (!limits)
        return reject(limits.error().message);

    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    const std::span<const Goal> goals{wanted->goals};
    std::cout << Json::of(rearrange(parsed->modifiers, parsed->village, goals, wanted->ranking, *limits, parsed->game), goals, wanted->ranking) << '\n';
    return 0;
}

/* A search repeated from the debug report the page writes for it. The output
   is the rearrange output, so the two can be compared line for line. */
int repro(const std::string& text)
{
    const auto parsed = Parse::repro(text);
    if (!parsed)
        return reject(parsed.error().message);

    const std::span<const Goal> goals{parsed->goals.goals};
    std::cout << Json::of(rearrange(parsed->village.modifiers, parsed->village.village, goals, parsed->goals.ranking, parsed->limits, parsed->village.game), goals, parsed->goals.ranking) << '\n';
    return 0;
}

/* The production of the layout a debug report answered with, which is the
   block the page was showing for it. Its output is the production output, so
   the two can be compared line for line. */
int reproFound(const std::string& text)
{
    const auto parsed = Parse::repro(text);
    if (!parsed)
        return reject(parsed.error().message);
    if (!parsed->found)
        return reject("the report carries no 'found' layout");

    ProductionDetail detail;
    AuraDetail auras;
    const Rules& rules = Rules::of(parsed->found->game);
    const Output output = runEffects(rules, parsed->found->modifiers, parsed->found->village, &detail, &auras);
    std::cout << Json::of(output, detail, auras, rules.game(), parsed->found->village, parsed->found->season) << '\n';
    return 0;
}

// A simulator run, replayed from its script. See Parse::script.
int simulate(const std::string& text)
{
    const auto parsed = Parse::script(text);
    if (!parsed)
        return reject(parsed.error().message);

    const Rules& rules = Rules::of(parsed->start.game);
    const Simulate::Report report = Simulate::replay(rules, parsed->start.modifiers, parsed->start.village, parsed->setup, parsed->steps, parsed->until);
    std::cout << Json::of(report, rules, parsed->start.modifiers) << '\n';
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    const std::vector<std::string_view> args{argv + 1, argv + argc};

    if (args.empty()) {
        std::cerr << "usage: harness <production|goals|effort|rearrange|repro|found|simulate> ...\n";
        return 2;
    }

    const std::string_view mode = args[0];

    if (mode == "production" && args.size() == 2)
        return production(slurp(argv[2]));
    if (mode == "parse" && args.size() == 2)
        return parsed(slurp(argv[2]));
    if (mode == "bench" && args.size() == 2)
        return bench(slurp(argv[2]));
    if (mode == "goals" && args.size() == 2)
        return goals(args[1]);
    if (mode == "effort" && args.size() == 2)
        return effort(args[1]);
    if (mode == "modifiers" && args.size() == 1)
        return modifiers();
    if (mode == "games" && args.size() == 1)
        return games();
    if (mode == "simulate" && args.size() == 2)
        return simulate(slurp(argv[2]));
    if (mode == "repro" && args.size() == 2)
        return repro(slurp(argv[2]));
    if (mode == "found" && args.size() == 2)
        return reproFound(slurp(argv[2]));
    if (mode == "rearrange" && args.size() == 4)
        return rearranged(slurp(argv[2]), args[2], args[3]);

    std::cerr << "bad arguments for mode '" << mode << "'\n";
    return 2;
}
