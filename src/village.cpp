#include "village.hpp"

#include "text.hpp"

#include <format>
#include <string>
#include <utility>

namespace Factions {

namespace Buildings {
namespace {
// Adding a building means adding an enumerator and a row here, at the same
// index in both. Nothing else in this namespace changes. Shape is absent: the
// games disagree on it, so it is read per game (see shapeOf).
//                                    id                          slots limit  max     tier type                  seal
constexpr std::array Table{
    Info{Building::None, "NONE", 0, 0, 0, 0, BuildingType::None, false},
    Info{Building::Hut, "WOODCUTTER", 1, 0, MaxLevel, 1, BuildingType::Economy, true},
    Info{Building::Mine, "MINE", 1, 0, MaxLevel, 1, BuildingType::Economy, true},
    Info{Building::Sawmill, "SAWMILL", 1, 0, MaxLevel, 2, BuildingType::Economy, true},
    Info{Building::Furnace, "FURNACE", 1, 0, MaxLevel, 2, BuildingType::Economy, true},
    Info{Building::VillageCentre, "VILLAGE_CENTRE", 0, 1, MaxLevel, 0, BuildingType::None, false},
    Info{Building::Obelisk, "OBELISK", 1, 3, MaxLevel, 4, BuildingType::Support, true},
    Info{Building::KnightTrainingCentre, "KNIGHT_TRAINING_CENTER", 1, 0, MaxLevel, 2, BuildingType::Military, true},
    Info{Building::GuardianTrainingCentre, "GUARDIAN_TRAINING_CENTER", 1, 0, MaxLevel, 2, BuildingType::Military, true},
    Info{Building::Storehouse, "STORAGE", 1, 0, MaxLevel, 1, BuildingType::Economy, true},
    Info{Building::Warehouse, "WAREHOUSE", 1, 0, MaxLevel, 2, BuildingType::Economy, true},
    Info{Building::TrainingCentre, "TRAINING_CENTER", 1, 0, MaxLevel, 1, BuildingType::Military, true},
    Info{Building::Tavern, "TAVERN", 1, 0, MaxLevel, 1, BuildingType::Worker, true},
    Info{Building::House, "HOUSE", 1, 0, MaxLevel, 1, BuildingType::None, true},
    Info{Building::GuardTower, "GUARD_TOWER", 1, 0, MaxLevel, 2, BuildingType::Military, true},
    Info{Building::Shipyard, "SHIPYARD", 1, 0, MaxLevel, 2, BuildingType::Economy, true},
    Info{Building::ResearchCentre, "RESEARCH_CENTER", 1, 0, MaxLevel, 2, BuildingType::Worker, true},
    Info{Building::BuildersBureau, "BUILDERS_BUREAU", 1, 0, MaxLevel, 2, BuildingType::Worker, true},
    Info{Building::Market, "MARKET", 1, 1, MaxLevel, 2, BuildingType::Economy, false},
    Info{Building::Arena, "ARENA", 1, 0, MaxLevel, 3, BuildingType::Military, true},
    Info{Building::GuildHall, "GUILD_HALL", 1, 0, MaxLevel, 3, BuildingType::Worker, true},
    Info{Building::TownHall, "TOWN_HALL", 1, 3, MaxLevel, 3, BuildingType::Economy, true},
    Info{Building::MercenaryOffice, "MERCENARY_OFFICE", 1, 0, MaxLevel, 4, BuildingType::Military, true},
    Info{Building::GarrisonHall, "GARRISON_HALL", 1, 1, MaxLevel, 4, BuildingType::Military, true},
    Info{Building::RecyclingWorkshop, "RECYCLING_WORKSHOP", 1, 1, 1, 4, BuildingType::Economy, false},
    Info{Building::Academy, "ACADEMY", 1, 1, 1, 4, BuildingType::Support, false},
};

static_assert(Table.size() == Enum::Count<Building>, "every Building enumerator needs a row in Table");

consteval bool rowsAreWellFormed()
{
    for (std::size_t a = 0; a < Table.size(); ++a) {
        const Info& row = Table[a];

        // A row is indexed by its enumerator, so the two orders must agree.
        if (row.building != static_cast<Building>(a))
            return false;
        if (row.id.empty())
            return false;
        if (row.slots < 0 || row.limit < 0 || row.maxLevel < 0 || row.tier < 0)
            return false;
        // Bare ground carries no level and no seal, which is why sealable()
        // alone answers for a tile as well as for a building.
        if ((row.building == Building::None) != (row.maxLevel == 0))
            return false;
        if (row.building == Building::None && row.sealable)
            return false;

        for (std::size_t b = a + 1; b < Table.size(); ++b)
            if (row.id == Table[b].id)
                return false;
    }
    return true;
}

static_assert(rowsAreWellFormed(), "each row must sit at its own enumerator, with a non-empty unique id, non-negative "
                                   "values, and no level or seal on bare ground");
} // namespace

std::span<const Info> all() { return Table; }

const Info& of(Building building) { return Table[static_cast<std::size_t>(building)]; }

std::optional<Building> tryFromId(std::string_view id)
{
    for (const Info& info : Table)
        if (info.id == id)
            return info.building;
    return std::nullopt;
}

} // namespace Buildings

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

    if (part[0] == Powers::Field) {
        if (ModifierSources::resourceOnly(*source))
            return std::nullopt;

        const std::optional<Power> power = Powers::tryFromId(part[1]);
        return power ? std::optional{found(modifiers.forQuantity(*power))} : std::nullopt;
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
        describeEverySource(Powers::Field, Powers::toId(power), true);

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
