#include "cost.hpp"

#include <cmath>

namespace Factions {

namespace Cost {
namespace {

// floor(base * growth^level). The api deals in whole resources, so the cost is
// floored here rather than carried fractional: a woodcutter's half worker
// costs nothing until the growth factor raises it above one.
double atLevel(double base, double growth, int level)
{
    return base == 0.0 ? 0.0 : std::floor(base * std::pow(growth, level));
}

// atLevel per resource, with the game's multiplier and the season factor folded
// into the growth. `workers` is false below the level that starts charging them.
Resources costAtLevel(const Resources& base, const Resources& multiplier, double growth, int level, bool workers, double season)
{
    return Resources{
        atLevel(base.wood, growth * multiplier.wood * season, level),
        atLevel(base.iron, growth * multiplier.iron * season, level),
        workers ? atLevel(base.workers, growth * multiplier.workers * season, level) : 0.0,
    };
}

Resources& operator+=(Resources& into, const Resources& more)
{
    into.wood += more.wood;
    into.iron += more.iron;
    into.workers += more.workers;
    return into;
}

const Game::Building* find(const Game::Config& game, Building building)
{
    if (building == Building::None || building == Building::VillageCentre)
        return nullptr;

    const std::string_view id = Buildings::toId(building);
    for (const Game::Building& one : game.buildings)
        if (one.name == id)
            return &one;

    return nullptr;
}

} // namespace

Resources toNextLevel(const Game::Config& game, Building building, int level, int season)
{
    const Game::Building* const one = find(game, building);
    if (one == nullptr || !one->upgradeable || level < 1 || level >= Buildings::maxLevel(building))
        return Resources{};

    // workersStart is the level from which an upgrade also charges workers,
    // named per building by the api rather than derived.
    return costAtLevel(one->cost.upgrade, game.buildingCost, BuildingGrowth, level, level >= one->cost.workersStart, Game::seasonStep(game, season));
}

Resources totalToLevel(const Game::Config& game, Building building, int level, int season)
{
    const Game::Building* const one = find(game, building);
    if (one == nullptr || level < 1)
        return Resources{};

    /* The build charges workers on the same terms an upgrade does: a woodcutter
       charges none below level 8, so its half worker is never paid.

       The season does not apply to a build. It is the level the growth starts
       from, where the multiplier is raised to the zero. Only upgrades scale. */
    Resources total = one->cost.build;
    if (one->cost.workersStart > 1)
        total.workers = 0.0;

    for (int at = 1; at < level; ++at)
        total += toNextLevel(game, building, at, season);

    return total;
}

Resources villageToNextLevel(const Game::Config& game, int level, int season)
{
    if (level < 1 || level >= MaxLevel)
        return Resources{};

    // Level 1 is the starting level, so the base is the cost of leaving it and
    // the exponent counts from there rather than from the level being paid for.
    return costAtLevel(game.villageBase, game.villageCost, VillageGrowth, level - 1, level >= game.villageWorkersStart, Game::seasonStep(game, season));
}

Resources villageTotalToLevel(const Game::Config& game, int level, int season)
{
    Resources total{};
    for (int at = 1; at < level; ++at)
        total += villageToNextLevel(game, at, season);

    return total;
}

Resources ofBuildings(const Game::Config& game, const Village& village, int season)
{
    Resources total{};
    // One tile per building: a multi-tile building is stored on its anchor and
    // its other tiles are derived from the shape, so nothing is counted twice.
    for (std::size_t i = 0; i < Village::Width * Village::Height; ++i)
        total += totalToLevel(game, village[i].building, village[i].level, season);

    return total;
}

} // namespace Cost

} // namespace Factions
