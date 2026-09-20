#pragma once

#include "game.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <span>
#include <string_view>
#include <vector>

namespace Factions {

enum class Terrain {
    HighMountain,
    Sea,
    Plains,
    Forest,
    Mountain,
    Swamp,

    Count // keep last; every enumerator above needs an id in Terrains
};

enum class Building {
    None,
    Hut,
    Mine,
    Sawmill,
    Furnace,
    VillageCentre,
    Obelisk,
    KnightTrainingCentre,
    GuardianTrainingCentre,
    Storehouse,
    Warehouse,
    TrainingCentre,
    Tavern,
    House,
    GuardTower,
    Shipyard,
    ResearchCentre,
    BuildersBureau,
    Market,
    Arena,
    GuildHall,
    TownHall,
    MercenaryOffice,
    GarrisonHall,
    RecyclingWorkshop,
    Academy,

    Count // keep last; every enumerator above needs a row in Buildings's table
};

// The build-menu category of a building. It affects no output; it is here so
// that one table describes a building completely.
enum class BuildingType {
    None,
    Economy,
    Military,
    Worker,
    Support,

    Count // keep last; every enumerator above needs an id in BuildingTypes
};

enum class Seal {
    None,
    Master,
    Mill,
    Barrel,

    Count // keep last; every enumerator above needs an id in Seals
};

// Which production the political bonus applies to. The factor is fixed; only
// its target is chosen.
enum class Politics {
    None,
    Resource, // wood and iron
    Worker,
    Soldier,

    Count // keep last; every enumerator above needs an id in PoliticsChoices
};

inline constexpr double PoliticsBonus = 1.10;

// A master builder's seal multiplies the level its building scales by; a mill
// or barrel seal multiplies what its own tile produces or stores.
inline constexpr double MasterSealBonus = 1.30;
inline constexpr double SealBonus = 1.50;

// The share of a sale the market keeps, before any reduction.
inline constexpr double BaseMarketTax = 0.40;

/* Quarter-turns clockwise from a shape's canonical position. A Line uses only
   East (its second tile east of the anchor) and South (south of it); an LShape
   uses all four, rotating which pair of arms it has about the anchor; a Square
   ignores it. */
enum class Orientation {
    East,
    South,
    West,
    North,

    Count // keep last; every enumerator above needs a char in Orientations
};

/* Each enum below has a companion namespace named for its plural, holding one
   array of ids in enumerator order plus whatever is constant per enumerator.
   The enumerator indexes the array, so a missing id is a size mismatch. */
namespace Enum {

template <typename E, typename Key, std::size_t N>
constexpr std::optional<E> find(const std::array<Key, N>& keys, Key key)
{
    for (std::size_t i = 0; i < N; ++i)
        if (keys[i] == key)
            return static_cast<E>(i);
    return std::nullopt;
}

template <typename Key, std::size_t N>
consteval bool allDifferent(const std::array<Key, N>& keys)
{
    for (std::size_t a = 0; a < N; ++a) {
        if constexpr (requires { keys[a].empty(); })
            if (keys[a].empty())
                return false;
        for (std::size_t b = a + 1; b < N; ++b)
            if (keys[a] == keys[b])
                return false;
    }
    return true;
}

template <typename E>
inline constexpr std::size_t Count = static_cast<std::size_t>(E::Count);

/* Every enumerator of E, in order, so a loop can name what it is iterating
   rather than counting indices and casting each one back. */
template <typename E>
constexpr std::array<E, Count<E>> values()
{
    std::array<E, Count<E>> all{};
    for (std::size_t i = 0; i < Count<E>; ++i)
        all[i] = static_cast<E>(i);
    return all;
}

} // namespace Enum

// The upper bound on any level, a village's or a building's.
inline constexpr int MaxLevel = 99;

/* The village centre's own effects. It is not in any game's building list, so
   its two quantities are stated here and read by effects.cpp. */
namespace Centre {
inline constexpr double WoodPerTick = 1.00;         // flat, independent of level
inline constexpr double AuraPerVillageLevel = 0.01; // share added to each adjacent tile
} // namespace Centre

// Resource x RateOrCapacity x ModifierSource enumerates every modifier id.
enum class Resource {
    Wood,
    Iron,
    Workers,
    Soldiers,

    Count
};

// A per-tick rate, or a storage capacity.
enum class RateOrCapacity {
    Rate,
    Capacity,

    Count
};

/* The five ratings the api groups under `world` and calls efficiencies. Each
   is a share added to the quantity it scales. */
enum class Efficiency {
    Attack,
    Defense,
    Worker,
    Map,
    Projects,

    Count
};

enum class Power {
    Support,
    Knight,
    Guardian,

    Count
};

// Knight and guardian production
enum class Unit {
    Knight,
    Guardian,

    Count
};

/* What contributes to one quantity, ordered by when it is applied: terrain
   twice (a share of the base, and a flat amount added to the base), the
   remaining shares, the factors over their sum, then redistribution, which is
   added after the multiplication.

   These are mostly the api's own `from` names. Two are not: the api calls
   SeasonalEvents `events`, and EventProjects `competitive_projects` where it
   names it at all. EventProjects also collects any bonus the api writes on a
   factor row, since such a bonus is a share of the same base the buildings
   feed rather than a factor over it.

   Talents is a specialisation's value. The api writes it as a factor on
   production (a merchant's 1.104 on wood and iron) and as a share on some
   world ratings, so it sits among the factors and accepts either form.

   Specialisation is a share the api names after the perk tree it was bought
   from: world.attack has a source called `attack`, world.worker one called
   `builder`. It applies to combat but not to resources, hence its position
   after the resource-only sources. */
enum class ModifierSource {
    Terrain,
    TerrainFlat,
    Improvements,
    Shrine,
    EventProjects,
    Specialisation,
    Projects,
    PersonalProject,
    SeasonalEvents,
    SupplyUpkeep,
    Talents,
    Redistribution,

    Count
};

namespace Resources {
inline constexpr std::array<std::string_view, Enum::Count<Resource>> Ids{
    "wood", "iron", "workers", "soldiers"
};
static_assert(Enum::allDifferent(Ids), "each resource needs an id of its own");

constexpr std::string_view toId(Resource r) { return Ids[static_cast<std::size_t>(r)]; }
constexpr std::optional<Resource> tryFromId(std::string_view id) { return Enum::find<Resource>(Ids, id); }
} // namespace Resources

/* What every village holds before a single building goes up, in Resource
   order. The buildings add to this rather than replacing it, and a modifier
   applies to the sum of the two. */
inline constexpr std::array<double, Enum::Count<Resource>> BaseStorage{500, 500, 100, 200};

inline constexpr double BasePower = 20.0;

namespace RateOrCapacities {
inline constexpr std::array<std::string_view, Enum::Count<RateOrCapacity>> Ids{"production", "storage"};
static_assert(Enum::allDifferent(Ids), "each measure needs an id of its own");

constexpr std::string_view toId(RateOrCapacity m) { return Ids[static_cast<std::size_t>(m)]; }
constexpr std::optional<RateOrCapacity> tryFromId(std::string_view id) { return Enum::find<RateOrCapacity>(Ids, id); }
} // namespace RateOrCapacities

namespace Efficiencies {
// The api field the five ids are nested under.
inline constexpr std::string_view Field = "efficiency";

inline constexpr std::array<std::string_view, Enum::Count<Efficiency>> Ids{
    "attack", "defense", "worker", "map", "projects"
};
static_assert(Enum::allDifferent(Ids), "each efficiency needs an id of its own");

// The two that scale soldier production into effective soldiers.
constexpr bool scalesSoldiers(Efficiency efficiency) { return efficiency == Efficiency::Attack || efficiency == Efficiency::Defense; }

/* The three that scale worker production into effective workers. Worker
   efficiency is a factor in all three; project efficiency is summed with it,
   map efficiency multiplies on top of it. */
constexpr bool scalesWorkers(Efficiency efficiency) { return efficiency == Efficiency::Worker || efficiency == Efficiency::Map || efficiency == Efficiency::Projects; }

/* Which of the five the quest multiplier applies to. Taken from the api,
   which lists quests against attack, defense and worker but not map or
   projects. */
constexpr bool scaledByQuests(Efficiency efficiency) { return efficiency != Efficiency::Map && efficiency != Efficiency::Projects; }

constexpr std::string_view toId(Efficiency efficiency) { return Ids[static_cast<std::size_t>(efficiency)]; }
constexpr std::optional<Efficiency> tryFromId(std::string_view id) { return Enum::find<Efficiency>(Ids, id); }
} // namespace Efficiencies

namespace Powers {

inline constexpr std::string_view Field = "power";

inline constexpr std::array<std::string_view, Enum::Count<Power>> Ids{
    "support", "knight", "guardian"
};
static_assert(Enum::allDifferent(Ids), "each power needs an id of its own");

constexpr bool countsTowardsBoth(Power power) { return power == Power::Support; }

constexpr std::string_view toId(Power power) { return Ids[static_cast<std::size_t>(power)]; }
constexpr std::optional<Power> tryFromId(std::string_view id) { return Enum::find<Power>(Ids, id); }
} // namespace Powers

namespace Units {

inline constexpr std::string_view Field = "production";

inline constexpr std::array<std::string_view, Enum::Count<Unit>> Ids{
    "knight", "guardian"
};
static_assert(Enum::allDifferent(Ids), "each unit needs an id of its own");

constexpr std::string_view toId(Unit unit) { return Ids[static_cast<std::size_t>(unit)]; }
constexpr std::optional<Unit> tryFromId(std::string_view id) { return Enum::find<Unit>(Ids, id); }
} // namespace Units

namespace ModifierSources {
inline constexpr std::array<std::string_view, Enum::Count<ModifierSource>> Ids{
    "terrain", "terrain_flat", "improvements", "shrine", "event_projects",
    "specialisation", "projects", "personal_project", "seasonal_events", "supply_upkeep",
    "talents", "redistribution"
};
static_assert(Enum::allDifferent(Ids), "each modifier source needs an id of its own");

constexpr std::string_view toId(ModifierSource source) { return Ids[static_cast<std::size_t>(source)]; }
constexpr std::optional<ModifierSource> tryFromId(std::string_view id) { return Enum::find<ModifierSource>(Ids, id); }

/* Added to the base before shares and factors scale it: terrain worth 100 of
   storage raises the quantity every share is taken of. */
constexpr bool addedBeforeMultiplier(ModifierSource source) { return source == ModifierSource::TerrainFlat; }

/* Added after every share and factor, so nothing scales it. The api writes
   resources sent by another village as a `raw_value` and reports the total
   both with and without it. */
constexpr bool addedAfterMultiplier(ModifierSource source) { return source == ModifierSource::Redistribution; }

// A term in the summed shares, rather than a factor multiplying their sum.
constexpr bool isShare(ModifierSource source) { return !addedBeforeMultiplier(source) && !addedAfterMultiplier(source) && source < ModifierSource::Projects; }

// Terrain, improvements and shrine apply to resources only, not to combat.
constexpr bool resourceOnly(ModifierSource source) { return source < ModifierSource::EventProjects; }

/* A factor is stored as the factor itself and a share as the share, so the
   two have different identity values and different lower bounds. */
constexpr double neutral(ModifierSource source) { return addedBeforeMultiplier(source) || addedAfterMultiplier(source) || isShare(source) ? 0.0 : 1.0; }
constexpr double minimum(ModifierSource source) { return isShare(source) ? -1.0 : 0.0; }
} // namespace ModifierSources

namespace Terrains {
inline constexpr std::array<std::string_view, Enum::Count<Terrain>> Ids{
    "HIGH_MOUNTAIN", "SEA", "PLAINS", "FOREST", "MOUNTAIN", "SWAMP"
};
static_assert(Enum::allDifferent(Ids), "each terrain needs an id of its own");

constexpr std::string_view toId(Terrain terrain) { return Ids[static_cast<std::size_t>(terrain)]; }
constexpr std::optional<Terrain> tryFromId(std::string_view id) { return Enum::find<Terrain>(Ids, id); }

constexpr bool buildable(Terrain terrain)
{
    return terrain != Terrain::HighMountain && terrain != Terrain::Sea;
}
} // namespace Terrains

namespace Orientations {
inline constexpr std::array<char, Enum::Count<Orientation>> Chars{'e', 's', 'w', 'n'};
static_assert(Enum::allDifferent(Chars), "each orientation needs a char of its own");

constexpr char toChar(Orientation orientation) { return Chars[static_cast<std::size_t>(orientation)]; }
constexpr std::optional<Orientation> tryFromChar(char c) { return Enum::find<Orientation>(Chars, c); }
} // namespace Orientations

namespace Seals {
inline constexpr std::array<std::string_view, Enum::Count<Seal>> Ids{
    "NONE", "LEVEL_BOOST", "ECONOMIC_BOOST", "STORAGE_EXPANDER"
};
static_assert(Enum::allDifferent(Ids), "each seal needs an id of its own");

constexpr std::string_view toId(Seal seal) { return Ids[static_cast<std::size_t>(seal)]; }
constexpr std::optional<Seal> tryFromId(std::string_view id) { return Enum::find<Seal>(Ids, id); }
} // namespace Seals

namespace PoliticsChoices {
// The name this choice is stored under, kept beside the choices themselves.
inline constexpr std::string_view Field = "politics";

inline constexpr std::array<std::string_view, Enum::Count<Politics>> Ids{
    "none", "resource", "worker", "soldier"
};
static_assert(Enum::allDifferent(Ids), "each politics needs an id of its own");
static_assert(Ids.front() == "none", "the choice that changes nothing comes first, so it is the default");

constexpr std::string_view toId(Politics politics) { return Ids[static_cast<std::size_t>(politics)]; }
constexpr std::optional<Politics> tryFromId(std::string_view id) { return Enum::find<Politics>(Ids, id); }
} // namespace PoliticsChoices

namespace BuildingTypes {
inline constexpr std::array<std::string_view, Enum::Count<BuildingType>> Ids{
    "NONE", "ECONOMY", "MILITARY", "WORKER", "SUPPORT"
};
static_assert(Enum::allDifferent(Ids), "each building type needs an id of its own");

constexpr std::string_view toId(BuildingType type) { return Ids[static_cast<std::size_t>(type)]; }
} // namespace BuildingTypes

// Indexed by the enumerator. Shape is absent: the games disagree on it, so it
// is read per game from Game::Building. See shapeOf below.
namespace Buildings {
struct Info {
    Building building;
    std::string_view id; // stable identifier, used in stored villages and in the UI
    int slots;           // village slots consumed; the centre and None cost none
    int limit;           // most a village may hold; 0 means no limit
    int maxLevel;        // highest level it may be raised to; 0 for bare ground
    int tier;            // which page of the build menu it sits on; 0 for neither
    BuildingType type;
    bool sealable; // whether a seal may be attached to it
};

std::span<const Info> all();
const Info& of(Building building);

inline std::string_view toId(Building building) { return of(building).id; }
inline int slots(Building building) { return of(building).slots; }
inline int limit(Building building) { return of(building).limit; }
inline int maxLevel(Building building) { return of(building).maxLevel; }
inline bool sealable(Building building) { return of(building).sealable; }

/* Whether this seal may be attached to this building. A mill multiplies the
   wood or iron produced on the building's own tile, so it fits only buildings
   that produce some; the other seals fit anything sealable. */
inline bool takesSeal(Building building, Seal seal)
{
    if (seal == Seal::None)
        return true;
    if (!sealable(building))
        return false;
    return seal != Seal::Mill || building == Building::Hut || building == Building::Mine || building == Building::TownHall;
}

std::optional<Building> tryFromId(std::string_view id);
} // namespace Buildings

struct Tile {
    Terrain terrain = Terrain::HighMountain;
    Building building = Building::None;
    Seal seal = Seal::None;
    int level = 0;
    // Only meaningful on the anchor tile of a multi-tile building.
    Orientation orientation = Orientation::East;
};

// The most tiles any shape covers: a Square's four.
inline constexpr std::size_t MaxFootprint = 4;

struct Footprint {
    std::array<std::pair<int, int>, MaxFootprint> tiles{};
    std::size_t count = 1;

    auto begin() const { return tiles.begin(); }
    auto end() const { return tiles.begin() + count; }
};

Footprint footprintOf(int x, int y, Game::Shape shape, Orientation orientation);
bool isInside(int x, int y);

/* The shape a building takes in this game. The centre is always Single.
   A building the game does not list (which should not happen for a real one)
   is treated as Single. */
Game::Shape shapeOf(const Game::Config& game, Building building);

class Village {
public:
    static constexpr std::size_t Width = 10;
    static constexpr std::size_t Height = 10;

    int level = 1;

    // What a terraformed tile scales its terrain effects by: the fertile
    // grounds perk, 1 + 0.05 a point. grid.terrainBonusFactor in the api.
    double terrainBonusFactor = 1.0;

    static constexpr std::size_t index(std::size_t x, std::size_t y) { return y * Width + x; }
    static constexpr std::pair<std::size_t, std::size_t> coordinates(std::size_t index)
    {
        return {
            index % Width,
            index / Width
        };
    }
    Village() = default;
    Tile& operator()(std::size_t x, std::size_t y) { return tiles[index(x, y)]; }
    const Tile& operator()(std::size_t x, std::size_t y) const { return tiles[index(x, y)]; }
    Tile& operator[](std::size_t i) { return tiles[i]; }
    const Tile& operator[](std::size_t i) const { return tiles[i]; }

    /* Terraformed ground, grid.terraformedTiles in the api. A bit per tile
       rather than a field on Tile, which would cost four bytes a tile in
       padding on every Village the search copies. */
    bool terraformed(std::size_t i) const { return (terraformed_[i / 64] >> (i % 64) & 1) != 0; }
    void setTerraformed(std::size_t i, bool ground)
    {
        const std::uint64_t bit = std::uint64_t{1} << (i % 64);
        if (ground)
            terraformed_[i / 64] |= bit;
        else
            terraformed_[i / 64] &= ~bit;
    }

private:
    std::array<Tile, Width * Height> tiles;
    std::array<std::uint64_t, (Width * Height + 63) / 64> terraformed_{};
};

/* Checks overlap, per-building limits, levels, seals and the slot budget, and
   returns a description of the first violation, or nothing. Takes a Village&
   because it overwrites the centre's level with the village's, and the game
   because footprints are read from it. */
std::optional<std::string> validate(Village& village, const Game::Config& game);

/* A building on terrain that cannot hold one. Checked separately from
   validate() because the editor can produce it deliberately (loading a round
   with a different map, or painting terrain under a building): reading a
   village back permits it, searching for an arrangement does not. */
std::optional<std::string> standingOnImpossibleGround(const Village& village, const Game::Config& game);

/* One value per resource: a per-tick rate, a capacity, or a share above 0.
   Indexed by Resource rather than named, so the tile loops can accumulate into
   the resource an effect names without a branch per contribution. */
struct ResourceTotals {
    std::array<double, Enum::Count<Resource>> by_resource{};

    constexpr double& operator[](Resource resource) { return by_resource[static_cast<std::size_t>(resource)]; }
    constexpr double operator[](Resource resource) const { return by_resource[static_cast<std::size_t>(resource)]; }
};

// What the market keeps, and what a tick's wood and iron sell for after it.
struct MarketTotals {
    double tax = 0.0;
    double wood = 0.0;
    double iron = 0.0;
};

struct Output {
    ResourceTotals production, storage;

    // One per Efficiency, in enumerator order, each a share above 0.
    std::array<double, Enum::Count<Efficiency>> efficiency{};

    /* One per Power, in enumerator order, each an absolute figure. Knight and
       guardian power each include the support power, which is also reported on
       its own. */
    std::array<double, Enum::Count<Power>> power{};

    // One per Unit, in enumerator order, per tick.
    std::array<double, Enum::Count<Unit>> units{};

    MarketTotals market;
};

constexpr double effectiveSoldiers(const Output& output, double efficiency)
{
    return output.production[Resource::Soldiers] * (1 + efficiency);
}

constexpr double efficiencyOf(const Output& output, Efficiency efficiency)
{
    return output.efficiency[static_cast<std::size_t>(efficiency)];
}

constexpr double powerOf(const Output& output, Power power)
{
    return output.power[static_cast<std::size_t>(power)];
}

constexpr double unitsOf(const Output& output, Unit unit)
{
    return output.units[static_cast<std::size_t>(unit)];
}

/* Worker production scaled by efficiency. Worker efficiency applies to every
   reading; project efficiency is summed with it, map efficiency multiplies on
   top of it, so passing Efficiency::Worker applies worker efficiency alone. */
constexpr double effectiveWorkers(const Output& output, Efficiency efficiency)
{
    const double worker = efficiencyOf(output, Efficiency::Worker);
    if (efficiency == Efficiency::Projects)
        return output.production[Resource::Workers] * (1 + worker + efficiencyOf(output, Efficiency::Projects));
    const double onTop = efficiency == Efficiency::Worker ? 1.0 : 1 + efficiencyOf(output, efficiency);
    return output.production[Resource::Workers] * (1 + worker) * onTop;
}

/* Every modifier applying to one quantity, one value per ModifierSource. They
   do not all combine the same way: some are summed as shares, some multiplied
   as factors, and some added before or after that multiplication. The five
   efficiencies use the same layout, with their resource-only sources holding
   the identity value and contributing nothing. */
struct ModifierSet {
    std::array<double, Enum::Count<ModifierSource>> bySource = identityValues();

    constexpr double& operator[](ModifierSource source) { return bySource[static_cast<std::size_t>(source)]; }
    constexpr double operator[](ModifierSource source) const { return bySource[static_cast<std::size_t>(source)]; }

    /* (1 + sharesFromBuildings + sum of the share sources) * product of the
       factor sources. Sources added before or after the multiplication take no
       part in it and are summed by the two functions below. */
    constexpr double multiplier(double sharesFromBuildings) const
    {
        return (1.0 + sharesFromBuildings + shares()) * factors();
    }

    constexpr double shares() const
    {
        double sum = 0.0;
        for (const ModifierSource source : Enum::values<ModifierSource>())
            if (ModifierSources::isShare(source))
                sum += (*this)[source];
        return sum;
    }

    constexpr double factors() const
    {
        double product = 1.0;
        for (const ModifierSource source : Enum::values<ModifierSource>())
            if (!ModifierSources::isShare(source) && !ModifierSources::addedBeforeMultiplier(source) && !ModifierSources::addedAfterMultiplier(source))
                product *= (*this)[source];
        return product;
    }

    // Added to the base, so multiplier() then scales it.
    constexpr double addedBeforeMultiplier() const { return sumOf(ModifierSources::addedBeforeMultiplier); }

    // Added after multiplier() has been applied, so nothing scales it.
    constexpr double addedAfterMultiplier() const { return sumOf(ModifierSources::addedAfterMultiplier); }

private:
    constexpr double sumOf(bool (*wanted)(ModifierSource)) const
    {
        double sum = 0.0;
        for (const ModifierSource source : Enum::values<ModifierSource>())
            if (wanted(source))
                sum += (*this)[source];
        return sum;
    }

    static constexpr std::array<double, Enum::Count<ModifierSource>> identityValues()
    {
        std::array<double, Enum::Count<ModifierSource>> out{};
        for (const ModifierSource source : Enum::values<ModifierSource>())
            out[static_cast<std::size_t>(source)] = ModifierSources::neutral(source);
        return out;
    }
};

struct GameModifiers {
    double quests = 1.00;
    double balance = 1.00;

    /* Subtracted from the market tax, in the same units: 0.10 leaves 0.30 of
       BaseMarketTax's 0.40. Only a merchant's perk is known to grant one and no
       api route reports it, so it is entered by hand rather than read. */
    double marketTaxReduction = 0.00;

    // Not a value to be entered: one production is chosen and multiplied by
    // PoliticsBonus.
    Politics politics = Politics::None;

    /* Rates and capacities are modified separately, so a shrine over what a
       village produces per tick need not affect what it can hold. */
    std::array<std::array<ModifierSet, Enum::Count<RateOrCapacity>>, Enum::Count<Resource>> resource_modifiers{};
    std::array<ModifierSet, Enum::Count<Efficiency>> efficiency_modifiers{};
    std::array<ModifierSet, Enum::Count<Power>> power_modifiers{};
    std::array<ModifierSet, Enum::Count<Unit>> unit_modifiers{};

    constexpr ModifierSet& forQuantity(Resource resource, RateOrCapacity rateOrCapacity) { return resource_modifiers[static_cast<std::size_t>(resource)][static_cast<std::size_t>(rateOrCapacity)]; }
    constexpr const ModifierSet& forQuantity(Resource resource, RateOrCapacity rateOrCapacity) const { return resource_modifiers[static_cast<std::size_t>(resource)][static_cast<std::size_t>(rateOrCapacity)]; }

    constexpr ModifierSet& forQuantity(Efficiency efficiency) { return efficiency_modifiers[static_cast<std::size_t>(efficiency)]; }
    constexpr const ModifierSet& forQuantity(Efficiency efficiency) const { return efficiency_modifiers[static_cast<std::size_t>(efficiency)]; }

    constexpr ModifierSet& forQuantity(Power power) { return power_modifiers[static_cast<std::size_t>(power)]; }
    constexpr const ModifierSet& forQuantity(Power power) const { return power_modifiers[static_cast<std::size_t>(power)]; }

    constexpr ModifierSet& forQuantity(Unit unit) { return unit_modifiers[static_cast<std::size_t>(unit)]; }
    constexpr const ModifierSet& forQuantity(Unit unit) const { return unit_modifiers[static_cast<std::size_t>(unit)]; }
};

/* Ids are '<resource>.<rate-or-capacity>.<source>',
   'efficiency.<efficiency>.<source>', '<power>.power.<source>' and
   '<unit>.production.<source>', built from the enums above, plus three that
   stand alone. No table lists them; find() and all() generate them. */
namespace ModifierIds {

struct Found {
    double* at;     // points into the modifiers it was asked about
    double neutral; // the value that changes nothing
    double minimum; // below this the multiplier would go negative
};

std::optional<Found> find(GameModifiers& modifiers, std::string_view id);

struct Described {
    std::string id;
    double neutral;
    double minimum;
    bool addedBeforeMultiplier; // added to the base, which shares and factors then scale
    bool addedAfterMultiplier;  // added once the multiplier has been applied
};

// Every modifier id, in a fixed order. Generated on demand: only a
// description of the api ever asks for it.
std::vector<Described> all();

} // namespace ModifierIds

using TileGrid = std::array<double, Village::Width * Village::Height>;

// ResourceTotals spread over the tiles that contributed to it.
struct ResourceGrids {
    std::array<TileGrid, Enum::Count<Resource>> by_resource{};

    constexpr TileGrid& operator[](Resource resource) { return by_resource[static_cast<std::size_t>(resource)]; }
    constexpr const TileGrid& operator[](Resource resource) const { return by_resource[static_cast<std::size_t>(resource)]; }
};

// The village-wide multipliers, each as a share above 0.
struct GlobalModifiers {
    ResourceTotals production, storage;
};

/* Building contributions before any modifier, as a base, as shares and as
   factors. Plain arrays, nothing that allocates: a search runs runEffects
   millions of times and pays for this on every one. */
struct FromBuildings {
    ResourceTotals production{}, storage{};

    // village-wide: applied to the totals above, not to the providing tile
    std::array<std::array<double, Enum::Count<RateOrCapacity>>, Enum::Count<Resource>> shares{}, multipliers{};

    std::array<double, Enum::Count<Efficiency>> efficiency{};
    std::array<double, Enum::Count<Power>> power{};

    std::array<double, Enum::Count<Unit>> units{}, unit_shares{}, unit_multipliers{};

    double market_tax = 0.0;    // before any reduction
    double tax_reduction = 0.0; // what the buildings take off it
};

struct ProductionDetail {
    GlobalModifiers global{};
    ResourceGrids production{};
    ResourceGrids storage{};

    // only for the detail reply; the search never reads it
    FromBuildings from_buildings{};
};

// The traversals the engine makes over a village, and the seal arithmetic.

template <typename Fn>
void forEachNeighbour(std::size_t i, Fn&& fn)
{
    const auto [x, y] = Village::coordinates(i);

    if (x > 0)
        fn(i - 1);
    if (x + 1 < Village::Width)
        fn(i + 1);
    if (y > 0)
        fn(i - Village::Width);
    if (y + 1 < Village::Height)
        fn(i + Village::Width);
}
// The level a building's effects scale by, after its seal.
inline double effectiveLevel(int level, Seal seal)
{
    return seal == Seal::Master ? MasterSealBonus * level : level;
}

inline double multiplierFromSeal(Seal seal, Seal kind)
{
    return seal == kind ? SealBonus : 1.0;
}

template <typename Fn>
void forEachTile(const Village& village, Fn&& fn)
{
    for (std::size_t i = 0; i < Village::Width * Village::Height; ++i)
        fn(i, village[i]);
}

} // namespace Factions
