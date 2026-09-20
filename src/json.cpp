#include "json.hpp"

#include "cost.hpp"
#include "game.hpp"

#include <array>
#include <format>
#include <iterator>
#include <string_view>

namespace Factions {

namespace Json {
namespace {

constexpr std::size_t TileCount = Village::Width * Village::Height;

void appendArray(std::string& out, std::string_view name, const std::array<double, TileCount>& values)
{
    std::format_to(std::back_inserter(out), "\"{}\":[", name);
    for (std::size_t i = 0; i < values.size(); ++i)
        std::format_to(std::back_inserter(out), "{}{:.10g}", i == 0 ? "" : ",", values[i]);
    out += ']';
}

// Keys in Resource order, which is the order the page reads them in.
void appendTotals(std::string& out, std::string_view name, const ResourceTotals& totals)
{
    std::format_to(std::back_inserter(out), "\"{}\":{{", name);
    bool first = true;
    for (const Resource resource : Enum::values<Resource>()) {
        std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", Resources::toId(resource), totals[resource]);
        first = false;
    }
    out += '}';
}

void appendResources(std::string& out, std::string_view name, const Cost::Resources& cost)
{
    std::format_to(std::back_inserter(out), "\"{}\":{{\"wood\":{:.10g},\"iron\":{:.10g},\"workers\":{:.10g}}}", name, cost.wood, cost.iron, cost.workers);
}

/* Build costs: the total over every building, then per building what has been
   spent and what the next level costs. The village's own levels are reported
   separately from the total, since they buy the village rather than anything
   standing on it. */
void appendCosts(std::string& out, const Game::Config& game, const Village& village, int season)
{
    out += "\"cost\":{";
    appendResources(out, "total", Cost::ofBuildings(game, village, season));

    std::format_to(std::back_inserter(out), ",\"village\":{{\"level\":{},", village.level);
    appendResources(out, "next", Cost::villageToNextLevel(game, village.level, season));
    out += ',';
    appendResources(out, "spent", Cost::villageTotalToLevel(game, village.level, season));
    out += "},\"buildings\":[";

    bool first = true;
    for (std::size_t i = 0; i < TileCount; ++i) {
        const Tile& tile = village[i];
        if (tile.building == Building::None || tile.building == Building::VillageCentre)
            continue;

        std::format_to(std::back_inserter(out), "{}{{\"tile\":{},\"level\":{},", first ? "" : ",", i, tile.level);
        first = false;
        appendResources(out, "next", Cost::toNextLevel(game, tile.building, tile.level, season));
        out += ',';
        appendResources(out, "spent", Cost::totalToLevel(game, tile.building, tile.level, season));
        out += '}';
    }
    out += "]}";
}

/* The efficiencies `wanted` selects, as "id":value pairs. The three blocks the
   reply carries differ only in which efficiencies they list and what they read
   for each. */
void appendEfficiencies(std::string& out, bool (*wanted)(Efficiency), const auto& valueOf)
{
    bool first = true;
    for (const Efficiency efficiency : Enum::values<Efficiency>()) {
        if (!wanted(efficiency))
            continue;
        std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", Efficiencies::toId(efficiency), valueOf(efficiency));
        first = false;
    }
}

/* Building contributions keyed by the same ids the modifiers use, in three
   blocks because the three combine differently: shares and factors apply to
   the base. The page holds the modifiers itself. */
void appendFromBuildings(std::string& out, const FromBuildings& from)
{
    bool first = true;
    const auto pair = [&](std::string_view id, double value) {
        std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", id, value);
        first = false;
    };

    const auto resourceId = [](Resource resource, RateOrCapacity rateOrCapacity) {
        return std::format("{}.{}", Resources::toId(resource), RateOrCapacities::toId(rateOrCapacity));
    };
    const auto unitId = [](Unit unit) { return std::format("{}.{}", Units::toId(unit), Units::Field); };

    out += "\"fromBuildings\":{\"base\":{";
    for (const Resource resource : Enum::values<Resource>())
        for (const RateOrCapacity rateOrCapacity : Enum::values<RateOrCapacity>())
            pair(resourceId(resource, rateOrCapacity),
                 (rateOrCapacity == RateOrCapacity::Rate ? from.production : from.storage)[resource]);
    for (const Unit unit : Enum::values<Unit>())
        pair(unitId(unit), from.units[static_cast<std::size_t>(unit)]);
    pair("market.tax", from.market_tax);

    out += "},\"shares\":{";
    first = true;
    for (const Resource resource : Enum::values<Resource>())
        for (const RateOrCapacity rateOrCapacity : Enum::values<RateOrCapacity>())
            pair(resourceId(resource, rateOrCapacity),
                 from.shares[static_cast<std::size_t>(resource)][static_cast<std::size_t>(rateOrCapacity)]);
    for (const Efficiency efficiency : Enum::values<Efficiency>())
        pair(std::format("{}.{}", Efficiencies::Field, Efficiencies::toId(efficiency)), from.efficiency[static_cast<std::size_t>(efficiency)]);
    for (const Power power : Enum::values<Power>())
        pair(std::format("{}.{}", Powers::toId(power), Powers::Field), from.power[static_cast<std::size_t>(power)]);
    for (const Unit unit : Enum::values<Unit>())
        pair(unitId(unit), from.unit_shares[static_cast<std::size_t>(unit)]);
    // subtracted from the tax, not a share of it
    pair("market.tax", -from.tax_reduction);

    out += "},\"factors\":{";
    first = true;
    for (const Resource resource : Enum::values<Resource>())
        for (const RateOrCapacity rateOrCapacity : Enum::values<RateOrCapacity>())
            pair(resourceId(resource, rateOrCapacity),
                 1 + from.multipliers[static_cast<std::size_t>(resource)][static_cast<std::size_t>(rateOrCapacity)]);
    for (const Unit unit : Enum::values<Unit>())
        pair(unitId(unit), 1 + from.unit_multipliers[static_cast<std::size_t>(unit)]);
    out += "}}";
}

void appendGrids(std::string& out, std::string_view name, const ResourceGrids& grids)
{
    std::format_to(std::back_inserter(out), "\"{}\":{{", name);
    bool first = true;
    for (const Resource resource : Enum::values<Resource>()) {
        if (!first)
            out += ',';
        appendArray(out, Resources::toId(resource), grids[resource]);
        first = false;
    }
    out += '}';
}

} // namespace

std::string of(const Output& output, const ProductionDetail& detail, const AuraDetail& auras, const Game::Config& game, const Village& village, int season)
{
    std::string out = "{";
    appendTotals(out, "production", output.production);
    out += ',';
    appendTotals(out, "storage", output.storage);

    /* Each efficiency, then the production it scales: soldiers for the two
       combat efficiencies, workers for the three worker efficiencies. */
    out += ",\"efficiency\":{";
    appendEfficiencies(out, [](Efficiency) { return true; }, [&](Efficiency efficiency) { return efficiencyOf(output, efficiency); });

    out += "},\"effective\":{\"soldiers\":{";
    appendEfficiencies(out, Efficiencies::scalesSoldiers, [&](Efficiency efficiency) { return effectiveSoldiers(output, efficiencyOf(output, efficiency)); });

    out += "},\"workers\":{";
    appendEfficiencies(out, Efficiencies::scalesWorkers, [&](Efficiency efficiency) { return effectiveWorkers(output, efficiency); });

    out += "}}";

    out += ",\"power\":{";
    {
        bool first = true;
        for (const Power power : Enum::values<Power>()) {
            std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", Powers::toId(power), powerOf(output, power));
            first = false;
        }
    }
    out += '}';

    out += ",\"units\":{";
    {
        bool first = true;
        for (const Unit unit : Enum::values<Unit>()) {
            std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", Units::toId(unit), unitsOf(output, unit));
            first = false;
        }
    }
    out += '}';

    std::format_to(std::back_inserter(out), ",\"market\":{{\"tax\":{:.10g},\"wood\":{:.10g},\"iron\":{:.10g}}}", output.market.tax, output.market.wood, output.market.iron);

    out += ",\"global\":{";
    appendTotals(out, "production", detail.global.production);
    out += ',';
    appendTotals(out, "storage", detail.global.storage);
    out += "},";

    appendFromBuildings(out, detail.from_buildings);
    out += ',';

    out += "\"tiles\":{";
    appendGrids(out, "production", detail.production);
    out += ',';
    appendGrids(out, "storage", detail.storage);
    /* Whatever auras this game's buildings provide, rather than a fixed list:
       the rounds disagree on which building provides what. */
    out += "},\"modifiers\":[";
    for (std::size_t a = 0; a < auras.sources.size(); ++a) {
        if (a > 0)
            out += ',';
        out += std::format("{{\"from\":\"{}\",\"quantity\":\"{}\",\"rateOrCapacity\":\"{}\",", Buildings::toId(auras.sources[a].from), Game::name(auras.sources[a].quantity), auras.sources[a].rateOrCapacity == Game::RateOrCapacity::Capacity ? "storage" : (auras.sources[a].rateOrCapacity == Game::RateOrCapacity::Rate ? "production" : "both"));
        appendArray(out, "values", auras.grid[a]);
        out += '}';
    }
    out += "],";
    appendCosts(out, game, village, season);
    out += '}';

    return out;
}

namespace {

template <typename Text>
void appendTileStrings(std::string& out, std::string_view name, const Village& village, Text&& text)
{
    std::format_to(std::back_inserter(out), "\"{}\":[", name);
    for (std::size_t i = 0; i < TileCount; ++i)
        std::format_to(std::back_inserter(out), "{}\"{}\"", i == 0 ? "" : ",", text(village[i]));
    out += ']';
}

void appendTerraformed(std::string& out, const Village& village)
{
    out += "\"terraformed\":[";
    for (std::size_t i = 0; i < TileCount; ++i)
        std::format_to(std::back_inserter(out), "{}{}", i == 0 ? "" : ",", village.terraformed(i) ? "true" : "false");
    out += ']';
}

void appendTileLevels(std::string& out, const Village& village)
{
    out += "\"levels\":[";
    for (std::size_t i = 0; i < TileCount; ++i)
        std::format_to(std::back_inserter(out), "{}{}", i == 0 ? "" : ",", village[i].level);
    out += ']';
}

// The four parallel arrays a village is written as, read back tile by tile.
// Shared by a search result and by a village that was only parsed.
void appendLayout(std::string& out, const Village& village)
{
    appendTileStrings(out, "buildings", village, [](const Tile& tile) { return Buildings::toId(tile.building); });
    out += ',';
    appendTileStrings(out, "seals", village, [](const Tile& tile) { return Seals::toId(tile.seal); });
    out += ',';
    appendTileStrings(out, "orientations", village, [](const Tile& tile) { return Orientations::toChar(tile.orientation); });
    out += ',';
    appendTileLevels(out, village);
}

} // namespace

std::string of(const Village& village)
{
    std::string out = std::format("{{\"level\":{},\"terrainBonusFactor\":{:.10g},", village.level, village.terrainBonusFactor);
    appendTileStrings(out, "terrain", village, [](const Tile& tile) { return Terrains::toId(tile.terrain); });
    out += ',';
    appendTerraformed(out, village);
    out += ',';
    appendLayout(out, village);
    return out + '}';
}

std::string of(const SearchResult& found, std::span<const Goal> goals, Ranking ranking)
{
    std::string out = "{\"goals\":[";
    for (std::size_t k = 0; k < goals.size(); ++k) {
        std::format_to(std::back_inserter(out), "{}{{\"id\":\"{}\",\"label\":\"{}\",\"weight\":{:.10g},\"before\":{:.10g},\"after\":{:.10g}", k == 0 ? "" : ",", goals[k].objective->id, goals[k].objective->label, goals[k].weight, found.before[k], found.after[k]);

        if (k < found.bestAlone.size())
            std::format_to(std::back_inserter(out), ",\"alone\":{:.10g}", found.bestAlone[k]);
        out += '}';
    }
    std::format_to(std::back_inserter(out), "],\"ranking\":\"{}\",", ranking == Ranking::WeightedSum ? "weighted-sum" : "lexicographic");

    std::format_to(std::back_inserter(out), "\"evaluated\":{},\"moved\":{},\"terraformed\":{},\"layout\":{{", found.evaluated, found.moved, found.terraformed);

    /* The terrain goes out with the layout, since a search allowed to
       terraform returns terrain the page does not already hold. */
    appendTileStrings(out, "terrain", found.village, [](const Tile& tile) { return Terrains::toId(tile.terrain); });
    out += ',';
    // which of them it terraformed, which terrainBonusFactor acts on
    appendTerraformed(out, found.village);
    out += ',';
    appendLayout(out, found.village);
    out += "}}";

    return out;
}

namespace {

// Named values in enum order, as one object.
template <typename E, typename Value>
void appendByEnum(std::string& out, std::string_view name, std::string_view (*idOf)(E), const Value& valueOf)
{
    std::format_to(std::back_inserter(out), "\"{}\":{{", name);
    bool first = true;
    for (const E which : Enum::values<E>()) {
        std::format_to(std::back_inserter(out), "{}\"{}\":{:.10g}", first ? "" : ",", idOf(which), static_cast<double>(valueOf(which)));
        first = false;
    }
    out += '}';
}

void appendState(std::string& out, std::string_view name, const Simulate::State& state)
{
    std::format_to(std::back_inserter(out), "\"{}\":{{\"tick\":{},\"season\":{},\"villageLevel\":{},\"slotsUsed\":{},\"recycling\":{:.10g},", name, state.tick, state.season, state.villageLevel, state.slotsUsed, state.recycling);

    appendTotals(out, "stock", state.stock.resource);
    out += ',';
    appendTotals(out, "production", state.production);
    out += ',';
    appendTotals(out, "capacity", state.capacity);
    out += ',';
    appendByEnum<Unit>(out, "charge", Units::toId, [&](Unit unit) { return state.stock.charge[static_cast<std::size_t>(unit)]; });
    out += ',';
    appendByEnum<Unit>(out, "unitProduction", Units::toId, [&](Unit unit) { return state.unitProduction[static_cast<std::size_t>(unit)]; });
    out += ',';
    appendByEnum<Seal>(out, "sealsStored", Seals::toId, [&](Seal seal) { return state.sealsStored[static_cast<std::size_t>(seal)]; });
    out += ',';
    appendByEnum<Seal>(out, "sealReadyAt", Seals::toId, [&](Seal seal) { return state.sealReadyAt[static_cast<std::size_t>(seal)]; });
    out += '}';
}

void appendStep(std::string& out, const Simulate::Step& step)
{
    // A step that acts on the village rather than a tile, and one with no
    // tile it came from, are written as null.
    std::format_to(std::back_inserter(out), "{{\"tick\":{},\"action\":\"{}\",\"tile\":{},\"from\":{},\"building\":\"{}\",\"level\":{},\"orientation\":\"{}\",\"seal\":\"{}\",", step.tick, Simulate::name(step.action), step.tile >= Simulate::NoTile ? std::string{"null"} : std::to_string(step.tile), step.from >= Simulate::NoTile ? std::string{"null"} : std::to_string(step.from), Buildings::toId(step.building), step.level, Orientations::toChar(step.orientation), Seals::toId(step.seal));

    appendResources(out, "paid", step.paid);
    out += ',';
    appendResources(out, "refunded", step.refunded);
    out += ',';
    appendState(out, "after", step.after);
    out += '}';
}

std::string escaped(std::string_view text)
{
    std::string out;
    for (const char c : text) {
        if (c == '"' || c == '\\')
            out += '\\';
        out += c;
    }
    return out;
}

} // namespace

std::string of(const Simulate::Report& report, const Rules& rules, const GameModifiers& modifiers)
{
    std::string out = "{";
    appendState(out, "start", report.start);

    out += ",\"steps\":[";
    for (std::size_t s = 0; s < report.steps.size(); ++s) {
        if (s > 0)
            out += ',';
        appendStep(out, report.steps[s]);
    }
    out += "],";

    if (report.refusal.empty())
        out += "\"refusal\":null,\"refusedAt\":null,";
    else
        std::format_to(std::back_inserter(out), "\"refusal\":\"{}\",\"refusedAt\":{},", escaped(report.refusal), report.refusedAt);

    appendState(out, "end", report.end);

    ProductionDetail detail;
    AuraDetail auras;
    const Output output = runEffects(rules, modifiers, report.village, &detail, &auras);

    out += ",\"village\":" + of(report.village);
    out += ",\"production\":" + of(output, detail, auras, rules.game(), report.village, report.end.season);
    return out + '}';
}

} // namespace Json

} // namespace Factions
