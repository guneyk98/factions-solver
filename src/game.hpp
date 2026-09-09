#pragma once

#include <span>
#include <string_view>

namespace Factions {

/* One game's rules, as the api describes them. Every quantity a building
   produces is stored here rather than compiled into the engine, because the
   games disagree: between rounds many buildings change the structure of their
   effects, not only the values.

   Generated into games.gen.cpp by tools/games-to-cpp.py from data/games/. */
namespace Game {

// Where an effect is read from, which decides what it applies to.
enum class Where {
    Base,     // the building itself, always
    Terrain,  // the building itself, on the ground named in `on`
    Adjacent, // the building itself, once per neighbour named in `on`
    Provides, // every neighbour named in `on`, from this building

    Count
};

// How the quantity combines. The api calls these base, bonus and multiplier.
enum class Amount {
    Flat,     // added as it stands
    Share,    // a percentage added to the summed shares
    Multiply, // a factor applied to the sum of the shares

    Count
};

/* The quantity an effect contributes to. Resources reach production and
   storage; the rest are not computed by this engine and are carried only so
   they can be reported rather than silently dropped. */
enum class Quantity {
    Wood,
    Iron,
    Workers,
    Soldiers,
    Knight,
    Guardian,
    MarketOrder,
    BuildOrder,
    Attack,
    Defense,
    MapEfficiency,
    WorkerProjectEfficiency,
    MarketTax,
    Efficiency, // an aura over whatever the target produces or holds

    // Enumerated so they can be reported as unmodelled; never counted.
    KnightPower,
    GuardianPower,
    Recycling,
    Specialization,

    Count
};

/* Both means an aura that names neither rate nor capacity and so applies to
   each; the api writes those as `efficiency`. */
enum class RateOrCapacity { Rate,
                            Capacity,
                            Both,
                            Count };

/* A building's footprint. The games disagree on this too: a building can
   occupy one tile in one round and three in the next, so it is read from the
   api rather than assumed. */
enum class Shape {
    Single, // one tile
    Line,   // two tiles, in the orientation asked for
    Square, // a fixed 2x2 block; orientation does not change it
    LShape, // three of a 2x2 block's four tiles, which one missing turns with the orientation

    Count
};

/* Wood, iron and workers together: either a cost or the factor a cost grows
   by. The api's base costs give fractional worker counts, so these are
   doubles and a cost is floored only after it has been computed. */
struct Resources {
    double wood = 0.0;
    double iron = 0.0;
    double workers = 0.0;
};

/* What a building's levels cost. Cost grows geometrically in the level being
   paid for: the exponent base is the same for every game, the per-game
   multiplier is not. See cost.hpp for the arithmetic. */
struct Cost {
    Resources build;   // putting one up, which is level 1
    Resources upgrade; // the base a level-to-level cost grows from
    int workersStart;  // the level from which an upgrade also takes workers
};

struct Effect {
    Where where;
    Amount amount;
    Quantity quantity;
    RateOrCapacity rateOrCapacity;
    double value;
    bool perLevel; // scales with the building's effective level
    bool global;   // reaches the whole village, not just its own tile
    /* Terrain names for Where::Terrain, building names for Adjacent and
       Provides, or a category for an aura over a whole kind. Empty means all. */
    std::span<const std::string_view> on;
    bool byCategory;
};

struct Building {
    std::string_view name;
    std::string_view category;
    int hq;   // the hq level that unlocks it
    int tier; // which page of the build menu
    Shape shape;
    int maxCount;     // 0 for no limit
    bool upgradeable; // false for the two that never leave level 1
    bool takesModules;
    std::span<const std::string_view> needsAdjacentTerrain;
    Cost cost;
    std::span<const Effect> effects;
};

/* One season, as the api reports it. Times are ISO 8601 verbatim: the engine
   passes them through to the page, which has a clock, and never parses them. */
struct Season {
    std::string_view name;
    std::string_view start;
    std::string_view end;
};

/* Every season change multiplies each cost multiplier by this. Confirmed by
   dividing it out once, which reproduced every cost recorded before the
   round's first season change. */
inline constexpr double SeasonCostStep = 0.99;

struct Config {
    int id;
    std::string_view map;
    /* Whether the round is still being played. Only an ongoing round can be
       queried for its players; a finished round's villages are in data/players
       and its events/list is empty. */
    bool ongoing;
    int width;
    int height;
    double marketTax; // the share the market keeps, before any reduction
    // Per-game cost multipliers, one per resource, for buildings and for the
    // village itself.
    Resources buildingCost;
    Resources villageCost;
    Resources villageBase; // what raising the village from level 1 takes
    int villageWorkersStart;
    std::span<const std::string_view> terrain; // width * height, row major
    std::span<const Building> buildings;

    /* The seasons in order, and the index of the one current when the cost
       multipliers above were fetched. Another season is costed relative to
       that index rather than from a count of elapsed seasons, since the api
       need not list them all. Empty, or -1, disables season scaling. */
    std::span<const Season> seasons;
    int seasonNow;
};

// SeasonCostStep^(season - seasonNow), or 1 where the game has no seasons.
double seasonStep(const Config& game, int season);

std::span<const Config> all();
const Config* find(int id);

// Whether this engine computes the quantity. Unmodelled ones are reported
// but never counted.
constexpr bool modelled(Quantity quantity)
{
    return quantity < Quantity::KnightPower;
}

std::string_view name(Quantity quantity);
std::string_view name(Where where);
std::string_view name(Amount amount);
std::string_view name(RateOrCapacity rateOrCapacity);
std::string_view name(Shape shape);

} // namespace Game

} // namespace Factions
