#pragma once

#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

#include "village.hpp"

namespace Factions {

namespace Objective {
struct Info {
    std::string_view id;
    std::string_view label;
    double (*read)(const Output&);
};

inline constexpr std::size_t Count = 19;

std::span<const Info> all();
const Info* find(std::string_view id);
} // namespace Objective

struct Goal {
    const Objective::Info* objective = nullptr;

    /* Under WeightedSum, how much this goal counts for. Under Ratio, its share
       of the target, in the goal's own units; 0 leaves it out of the ratio.
       Unread under Lexicographic. */
    double weight = 1.0;

    // The value this goal must reach, under any ranking. 0 asks for nothing.
    double atLeast = 0.0;
};

/* How two arrangements are compared. Lexicographic reads the goals in order,
   each breaking the ties left by the one above. WeightedSum sums every goal
   normalised by the value it reaches when optimised alone.

   Ratio maximises min(value / weight) over the goals carrying a weight: the
   Leontief production function, with the weights its input requirement vector.
   A goal in surplus buys nothing, so the arrangement is pushed towards the
   ratio the weights give. With the weights the wood, iron and worker cost of an
   upgrade and the goals the three productions, that minimum is the reciprocal
   of the ticks the upgrade takes to afford. Ties break on the sum of the same
   terms, then on the goals in order, the only comparison a goal with no target
   takes part in.

   Under every ranking, fewer missed minimums ranks above more. See
   Goal::atLeast. */
enum class Ranking {
    Lexicographic,
    WeightedSum,
    Ratio,
};

/* A terraform budget of None leaves the terrain as the map has it; Unlimited
   bounds the count by nothing but the arrangement. Only a tile a building
   stands on is ever terraformed, and only to a terrain that building's own
   effects name, since terrain reaches the output through Where::Terrain
   alone. */
namespace Terraforming {
inline constexpr int None = 0;
inline constexpr int Unlimited = -1;
} // namespace Terraforming

struct SearchLimits {
    int restarts = 24;
    int iterations = 100000;
    int improvementPasses = 40; // how many times the best single change may be applied
    long long budget = 200000;  // arrangements evaluated, per restart
    std::uint64_t seed = 0x9E3779B97F4A7C15ull;

    // How many tiles the search may terraform, or one of the two constants above.
    int terraform = Terraforming::None;

    /* Which restarts to run, so the work can be split across workers. A
       restartCount of 0 runs every restart from firstRestart onwards. Each
       restart seeds its own random sequence, so any split evaluates the same
       arrangements the undivided run would. */
    int firstRestart = 0;
    int restartCount = 0;
};

struct SearchResult {
    Village village;
    std::vector<double> before;
    std::vector<double> after;
    std::vector<double> bestAlone; // what each goal reaches when optimised by itself
    long long evaluated = 0;       // arrangements scored, over the whole run
    int moved = 0;
    int terraformed = 0; // tiles whose terrain differs from the map's own
};

/* How many multiples of the target these values supply: the smallest
   value/weight over the goals with a weight above 0, or 0 if none has one.
   `values` holds one reading per goal, as SearchResult::before and ::after. */
double targetMultiple(std::span<const Goal> goals, std::span<const double> values);

/* The goal attaining that minimum, which is the one holding the arrangement
   back, or goals.size() if none has a weight above 0. */
std::size_t bindingGoal(std::span<const Goal> goals, std::span<const double> values);

// `game` selects which round's rules score an arrangement; 0 selects the newest.
SearchResult rearrange(const GameModifiers& modifiers, const Village& village, std::span<const Goal> goals, Ranking ranking = Ranking::Lexicographic, SearchLimits limits = {}, int game = 0);

} // namespace Factions
