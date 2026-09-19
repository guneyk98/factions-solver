#include <cstdlib>
#include <cstring>
#include <span>
#include <string>

#include "parse.hpp"
#include "json.hpp"
#include "effects.hpp"
#include "simulate.hpp"
#include "solver.hpp"
#include "village.hpp"

#include <emscripten/emscripten.h>

using namespace Factions;

namespace {

char* release(const std::string& text)
{
    auto* const out = static_cast<char*>(std::malloc(text.size() + 1));
    if (out != nullptr)
        std::memcpy(out, text.c_str(), text.size() + 1);
    return out;
}

char* reject(const std::string& message)
{
    return release("!" + message);
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void apiFree(char* text)
{
    std::free(text);
}

/* Parses village text and returns the village it describes, so the page can
   write that text without also implementing a reader for it. */
EMSCRIPTEN_KEEPALIVE
char* apiParse(const char* text)
{
    const auto parsed = Parse::readableVillage(text);
    if (!parsed)
        return reject(parsed.error().message);

    return release(Json::of(parsed->village));
}

EMSCRIPTEN_KEEPALIVE
char* apiProduction(const char* text)
{
    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    ProductionDetail detail;
    AuraDetail auras;
    const Rules& rules = Rules::of(parsed->game);
    const Output output = runEffects(rules, parsed->modifiers, parsed->village, &detail, &auras);
    return release(Json::of(output, detail, auras, rules.game(), parsed->village, parsed->season));
}

EMSCRIPTEN_KEEPALIVE
char* apiRearrange(const char* text, const char* goal, const char* effort)
{
    const auto wanted = Parse::goals(goal);
    if (!wanted)
        return reject(wanted.error().message);

    const auto limits = Parse::effort(effort == nullptr ? "" : effort);
    if (!limits)
        return reject(limits.error().message);

    const auto parsed = Parse::village(text);
    if (!parsed)
        return reject(parsed.error().message);

    const std::span<const Goal> goals{wanted->goals};
    return release(Json::of(rearrange(parsed->modifiers, parsed->village, goals, wanted->ranking, *limits, parsed->game), goals, wanted->ranking));
}

/* Replays a simulator script and returns the run: every step with what it cost
   and what followed it, and the whole production block for the state it
   finished in. */
EMSCRIPTEN_KEEPALIVE
char* apiSimulate(const char* text)
{
    const auto parsed = Parse::script(text);
    if (!parsed)
        return reject(parsed.error().message);

    const Rules& rules = Rules::of(parsed->start.game);
    const Simulate::Report report = Simulate::replay(rules, parsed->start.modifiers, parsed->start.village, parsed->setup, parsed->steps, parsed->until);
    return release(Json::of(report, rules, parsed->start.modifiers));
}

} // extern "C"
