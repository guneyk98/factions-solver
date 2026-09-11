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
    std::string out = std::format("{{\"level\":{},", village.level);
    appendTileStrings(out, "terrain", village, [](const Tile& tile) { return Terrains::toId(tile.terrain); });
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

    std::format_to(std::back_inserter(out), "\"evaluated\":{},\"moved\":{},\"layout\":{{", found.evaluated, found.moved);

    appendLayout(out, found.village);
    out += "}}";

    return out;
}

} // namespace Json

} // namespace Factions
