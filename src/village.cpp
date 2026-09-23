#include "village.hpp"

#include "text.hpp"

#include <format>
#include <string>
#include <utility>

namespace Factions {

namespace ModifierIds {
namespace {

/* The three modifiers that belong to no ModifierSet: each is a single field of
   GameModifiers, addressed by a pointer to member. */
struct Standalone {
    std::string_view id;
    double GameModifiers::* at;
    double neutral;
    double minimum;
};

constexpr std::array Standalones{
    Standalone{"quests", &GameModifiers::quests, 1.0, 0.0},
    Standalone{"balance", &GameModifiers::balance, 1.0, 0.0},
    Standalone{"market_tax_reduction", &GameModifiers::marketTaxReduction, 0.0, 0.0},
};

static_assert(Enum::allDifferent(std::array{Standalones[0].id, Standalones[1].id, Standalones[2].id}), "each standalone modifier needs an id of its own");

consteval bool neutralsMatchTheDefaults()
{
    const GameModifiers fresh{};
    for (const Standalone& standalone : Standalones)
        if (fresh.*standalone.at != standalone.neutral)
            return false;

    // Every set starts at the identity value each source calls for.
    for (const ModifierSource source : Enum::values<ModifierSource>())
        if (ModifierSet{}[source] != ModifierSources::neutral(source))
            return false;
    return true;
}

static_assert(neutralsMatchTheDefaults(), "every modifier's neutral must equal its default in GameModifiers");

} // namespace

std::optional<Found> find(GameModifiers& modifiers, std::string_view id)
{
    for (const Standalone& standalone : Standalones)
        if (standalone.id == id)
            return Found{&(modifiers.*standalone.at), standalone.neutral, standalone.minimum};

    const std::vector<std::string_view> part = Text::split(id, '.');
    if (part.size() != 3)
        return std::nullopt;

    const std::optional<ModifierSource> source = ModifierSources::tryFromId(part[2]);
    if (!source)
        return std::nullopt;

    const auto found = [&](ModifierSet& set) {
        return Found{&set[*source], ModifierSources::neutral(*source), ModifierSources::minimum(*source)};
    };

    if (part[0] == Efficiencies::Field) {
        // Terrain, improvements and shrines do not apply to combat.
        if (ModifierSources::resourceOnly(*source))
            return std::nullopt;

        const std::optional<Efficiency> efficiency = Efficiencies::tryFromId(part[1]);
        return efficiency ? std::optional{found(modifiers.forQuantity(*efficiency))} : std::nullopt;
    }

    if (const std::optional<Power> power = Powers::tryFromId(part[0]); power && part[1] == Powers::Field) {
        if (ModifierSources::resourceOnly(*source))
            return std::nullopt;

        return found(modifiers.forQuantity(*power));
    }

    if (const std::optional<Unit> unit = Units::tryFromId(part[0]); unit && part[1] == Units::Field) {
        // The api puts no terrain, improvement or shrine row on either.
        if (ModifierSources::resourceOnly(*source))
            return std::nullopt;

        return found(modifiers.forQuantity(*unit));
    }

    const std::optional<Resource> resource = Resources::tryFromId(part[0]);
    const std::optional<RateOrCapacity> rateOrCapacity = RateOrCapacities::tryFromId(part[1]);
    if (!resource || !rateOrCapacity)
        return std::nullopt;

    return found(modifiers.forQuantity(*resource, *rateOrCapacity));
}

std::vector<Described> all()
{
    std::vector<Described> described;

    for (const Standalone& standalone : Standalones)
        described.push_back(Described{std::string{standalone.id}, standalone.neutral, standalone.minimum, false, false});

    const auto describeEverySource = [&](std::string_view first, std::string_view second, bool combat) {
        for (const ModifierSource source : Enum::values<ModifierSource>()) {
            if (combat && ModifierSources::resourceOnly(source))
                continue;
            described.push_back(Described{
                std::format("{}.{}.{}", first, second, ModifierSources::toId(source)),
                ModifierSources::neutral(source),
                ModifierSources::minimum(source),
                ModifierSources::addedBeforeMultiplier(source),
                ModifierSources::addedAfterMultiplier(source),
            });
        }
    };

    for (const Resource resource : Enum::values<Resource>())
        for (const RateOrCapacity rateOrCapacity : Enum::values<RateOrCapacity>())
            describeEverySource(Resources::toId(resource), RateOrCapacities::toId(rateOrCapacity), false);

    for (const Efficiency efficiency : Enum::values<Efficiency>())
        describeEverySource(Efficiencies::Field, Efficiencies::toId(efficiency), true);

    for (const Power power : Enum::values<Power>())
        describeEverySource(Powers::toId(power), Powers::Field, true);

    for (const Unit unit : Enum::values<Unit>())
        describeEverySource(Units::toId(unit), Units::Field, true);

    return described;
}

} // namespace ModifierIds

Footprint footprintOf(int x, int y, Game::Shape shape, Orientation orientation)
{
    Footprint result;
    result.tiles[0] = {x, y};
    result.count = 1;

    switch (shape) {
    case Game::Shape::Single:
        return result;

    case Game::Shape::Line:
        result.tiles[1] = orientation == Orientation::South
                              ? std::pair{x, y + 1}
                              : std::pair{x + 1, y};
        result.count = 2;
        return result;

    case Game::Shape::Square:
        // A fixed quadrant to the anchor's right and below; orientation does
        // not change it.
        result.tiles[1] = {x + 1, y};
        result.tiles[2] = {x, y + 1};
        result.tiles[3] = {x + 1, y + 1};
        result.count = 4;
        return result;

    case Game::Shape::LShape:
    default:
        // The anchor is the corner tile, adjacent to both arms. A clockwise
        // quarter-turn selects which pair of arms it has.
        switch (orientation) {
        case Orientation::East:
            result.tiles[1] = {x + 1, y};
            result.tiles[2] = {x, y + 1};
            break;
        case Orientation::South:
            result.tiles[1] = {x, y + 1};
            result.tiles[2] = {x - 1, y};
            break;
        case Orientation::West:
            result.tiles[1] = {x - 1, y};
            result.tiles[2] = {x, y - 1};
            break;
        case Orientation::North:
            result.tiles[1] = {x, y - 1};
            result.tiles[2] = {x + 1, y};
            break;
        default: break;
        }
        result.count = 3;
        return result;
    }
}

bool isInside(int x, int y)
{
    return x >= 0 && x < static_cast<int>(Village::Width) && y >= 0 && y < static_cast<int>(Village::Height);
}

Game::Shape shapeOf(const Game::Config& game, Building building)
{
    if (building == Building::VillageCentre)
        return Game::Shape::Single;

    const std::string_view id = Buildings::toId(building);
    for (const Game::Building& b : game.buildings)
        if (b.name == id)
            return b.shape;

    return Game::Shape::Single;
}

std::optional<std::string> validate(Village& village, const Game::Config& game)
{
    if (village.level > MaxLevel)
        return std::format("village level {} is past the highest, {}", village.level, MaxLevel);

    std::array<bool, Village::Width * Village::Height> occupied{};
    std::array<int, Enum::Count<Building>> counts{};
    std::size_t centres = 0;
    int used_slots = 0;

    for (std::size_t i = 0; i < occupied.size(); ++i) {
        const auto [x, y] = Village::coordinates(i);
        Tile& tile = village(x, y);

        if (tile.building == Building::None) {
            if (tile.seal != Seal::None)
                return std::format("a {} seal at ({}, {}) has no building to sit on", Seals::toId(tile.seal), x, y);
            if (tile.level != 0)
                return std::format("bare ground at ({}, {}) is at level {}, but nothing stands there", x, y, tile.level);
            continue;
        }

        // The centre's level is the village's level, so whatever the parsed
        // text gave for it is overwritten.
        if (tile.building == Building::VillageCentre) {
            ++centres;
            tile.level = village.level;
        }
        used_slots += Buildings::slots(tile.building);

        const Buildings::Info& info = Buildings::of(tile.building);

        if (tile.level < 1 || tile.level > info.maxLevel)
            return info.maxLevel == 1
                       ? std::format("{} at ({}, {}) is at level {}, but it only ever stands at level 1", info.id, x, y, tile.level)
                       : std::format("{} at ({}, {}) is at level {}, which is outside 1 to {}", info.id, x, y, tile.level, info.maxLevel);

        const int count = ++counts[static_cast<std::size_t>(tile.building)];
        if (info.limit > 0 && count > info.limit)
            return std::format("a village may hold at most {} {}, got {}", info.limit, info.id, count);

        for (const auto& [cx, cy] : footprintOf(static_cast<int>(x), static_cast<int>(y), shapeOf(game, tile.building), tile.orientation)) {
            if (!isInside(cx, cy))
                return std::format("{} at ({}, {}) extends outside the village", info.id, x, y);

            const std::size_t ci = Village::index(static_cast<std::size_t>(cx), static_cast<std::size_t>(cy));
            if (occupied[ci])
                return std::format("{} at ({}, {}) overlaps another building at ({}, {})", info.id, x, y, cx, cy);
            occupied[ci] = true;
        }
    }

    if (centres != 1)
        return std::format("expected exactly one village centre, got {}", centres);
    if (used_slots > village.level)
        return std::format("village level {} allows {} slot{}, got {}", village.level, village.level, village.level == 1 ? "" : "s", used_slots);

    return std::nullopt;
}

std::optional<std::string> standingOnImpossibleGround(const Village& village, const Game::Config& game)
{
    for (std::size_t i = 0; i < Village::Width * Village::Height; ++i) {
        const auto [x, y] = Village::coordinates(i);
        const Tile& tile = village(x, y);
        if (tile.building == Building::None)
            continue;

        for (const auto& [cx, cy] : footprintOf(static_cast<int>(x), static_cast<int>(y), shapeOf(game, tile.building), tile.orientation)) {
            if (!isInside(cx, cy))
                continue; // validate() reports this, with a better message

            const Terrain terrain = village(static_cast<std::size_t>(cx), static_cast<std::size_t>(cy)).terrain;
            if (!Terrains::buildable(terrain))
                return std::format("tile {} at ({}, {}) cannot hold a building", Terrains::toId(terrain), cx, cy);
        }
    }
    return std::nullopt;
}

} // namespace Factions
