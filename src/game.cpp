#include "game.hpp"

#include <array>
#include <cmath>

namespace Factions {

namespace Game {
namespace {

constexpr std::array<std::string_view, static_cast<std::size_t>(Quantity::Count)> QuantityNames{
    "wood",
    "iron",
    "workers",
    "soldiers",
    "knight",
    "guardian",
    "market_order",
    "build_order",
    "attack",
    "defense",
    "map_efficiency",
    "worker_project_efficiency",
    "knightPower",
    "guardianPower",
    "market_tax",
    "efficiency",
    "recycling",
    "specialization",
};

constexpr std::array<std::string_view, static_cast<std::size_t>(Where::Count)> WhereNames{
    "base",
    "terrain",
    "adjacent",
    "provides",
};

constexpr std::array<std::string_view, static_cast<std::size_t>(Amount::Count)> AmountNames{
    "flat",
    "share",
    "multiply",
};

constexpr std::array<std::string_view, static_cast<std::size_t>(RateOrCapacity::Count)> RateOrCapacityNames{
    "production",
    "storage",
    "both",
};

constexpr std::array<std::string_view, static_cast<std::size_t>(Shape::Count)> ShapeNames{
    "single",
    "line",
    "square",
    "l",
};

} // namespace

double seasonStep(const Config& game, int season)
{
    /* Only the distance from seasonNow matters, so an index past the end of
       the recorded list is still costed: the api reveals future seasons a few
       at a time and a planner may look further ahead than that. */
    if (game.seasonNow < 0 || season < 0)
        return 1.0;

    return std::pow(SeasonCostStep, season - game.seasonNow);
}

std::string_view name(Quantity quantity) { return QuantityNames[static_cast<std::size_t>(quantity)]; }
std::string_view name(Where where) { return WhereNames[static_cast<std::size_t>(where)]; }
std::string_view name(Amount amount) { return AmountNames[static_cast<std::size_t>(amount)]; }
std::string_view name(RateOrCapacity rateOrCapacity) { return RateOrCapacityNames[static_cast<std::size_t>(rateOrCapacity)]; }
std::string_view name(Shape shape) { return ShapeNames[static_cast<std::size_t>(shape)]; }

} // namespace Game

} // namespace Factions
