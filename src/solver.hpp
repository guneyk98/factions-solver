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

inline constexpr std::size_t Count = 18;

std::span<const Info> all();
const Info* find(std::string_view id);
} // namespace Objective

struct Goal {
    const Objective::Info* objective = nullptr;
    double weight = 1.0;
};

/* How a search with several goals compares two arrangements: lexicographically
   (by the first goal, ties broken by the second, and so on), or by the weighted
   sum of every goal normalised by the value it reaches when optimised alone. */
enum class Ranking {
    Lexicographic,
    WeightedSum,
};

struct SearchLimits {
    int restarts = 24;
    int iterations = 100000;
    int improvementPasses = 40; // how many times the best single change may be applied
    long long budget = 200000;  // arrangements evaluated, per restart
    std::uint64_t seed = 0x9E3779B97F4A7C15ull;

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
};

// `game` selects which round's rules score an arrangement; 0 selects the newest.
SearchResult rearrange(const GameModifiers& modifiers, const Village& village, std::span<const Goal> goals, Ranking ranking = Ranking::Lexicographic, SearchLimits limits = {}, int game = 0);

} // namespace Factions
