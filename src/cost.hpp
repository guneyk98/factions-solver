#pragma once

#include "game.hpp"
#include "village.hpp"

namespace Factions {

namespace Cost {

// Per-level growth factor, before the game's own multiplier.
inline constexpr double BuildingGrowth = 1.60;
inline constexpr double VillageGrowth = 1.53;

// Wood, iron and workers, here as a cost rather than as a stock.
using Resources = Game::Resources;

/* Cost of upgrading this building from `level` to `level + 1`. Zero for the
   village centre, whose levels are the village's and costed separately, for a
   building this game does not have, and for one already at its max level. */
Resources toNextLevel(const Game::Config& game, Building building, int level, int season = -1);

// Cost of building it plus every upgrade up to `level`.
Resources totalToLevel(const Game::Config& game, Building building, int level, int season = -1);

/* The same two for the village. Level 1 is the starting level rather than a
   purchase, so villageTotalToLevel is zero at level 1. */
Resources villageToNextLevel(const Game::Config& game, int level, int season = -1);
Resources villageTotalToLevel(const Game::Config& game, int level, int season = -1);

/* Total spent on every building in this village. Excludes the village centre,
   whose levels are the village's own and costed separately. */
Resources ofBuildings(const Game::Config& game, const Village& village, int season = -1);

} // namespace Cost

} // namespace Factions
