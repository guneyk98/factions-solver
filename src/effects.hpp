#pragma once

#include "game.hpp"
#include "games.gen.hpp"
#include "village.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace Factions {

/* Computes a village's output by interpreting one game's rules, rather than
   from arithmetic compiled into the engine. Between a third and two thirds of
   the buildings change the structure of their effects between rounds, so the
   selected round determines the rules used. */

// One aura a building provides to its neighbours.
struct Aura {
    Building from;
    Game::Quantity quantity;
    Game::RateOrCapacity rateOrCapacity;
    std::string label; // "SAWMILL production", the name the page displays
};

/* Both bounds are counted from the games compiled in (see games.gen.hpp), so
   they are exact rather than guessed and a new round widens them instead of
   overflowing them.

   At eight auras a tile's row of them is one 64-byte cache line, which is how
   they are stored and read. */
inline constexpr std::size_t MaxAuras = Game::MostAuras;
inline constexpr std::size_t MaxEffects = Game::MostEffectsPerBuilding;

struct AuraDetail {
    std::vector<Aura> sources;
    std::vector<TileGrid> grid; // one per source, same order
};

/* One game's rules, indexed for the tile loops: effects looked up by
   building, and one aura grid per aura. Built once per game and cached, since
   a search reads it millions of times. */
class Rules {
public:
    static const Rules& of(int game); // falls back to the newest game

    const Game::Config& game() const { return *game_; }

    // The building's shape in this game, cached: the free shapeOf() scans the
    // game's building list, which is too slow for the tile loops.
    Game::Shape shapeOf(Building b) const { return shape_[static_cast<std::size_t>(b)]; }

    std::span<const Game::Effect> effects(Building b) const
    {
        return effects_[static_cast<std::size_t>(b)];
    }

    const Game::Building* describes(Building b) const { return describes_[static_cast<std::size_t>(b)]; }

    // Every aura in this game, in the order of their grids.
    std::span<const Aura> auras() const { return auras_; }

    // Which aura grid a building's nth effect feeds, or none.
    int auraSlotOfEffect(Building building, std::size_t nth) const;

    /* The buildings, or terrains, an effect's `on` list names, as a bit per
       enum value. Precomputed: matching by name in the neighbour loop costs a
       string comparison per neighbour per effect per tile. */
    std::uint32_t targetsOfEffect(Building b, std::size_t nth) const
    {
        return targets_[static_cast<std::size_t>(b)][nth];
    }

    /* Where each of a building's effects lands. Several effects often reach
       the same quantity (a woodcutter's base wood and its forest wood), so
       they accumulate into one running total per quantity. The mapping from
       effect to running total is fixed, so it is computed here rather than
       searched for on every tile of every arrangement. */
    struct QuantityAndRateOrCapacity {
        std::uint8_t quantity;
        std::uint8_t rateOrCapacity;
    };

    std::size_t runningTotalCount(Building b) const { return running_total_count_[static_cast<std::size_t>(b)]; }
    std::size_t runningTotalOfEffect(Building b, std::size_t nth) const { return running_total_of_effect_[static_cast<std::size_t>(b)][nth]; }
    QuantityAndRateOrCapacity quantityAt(Building b, std::size_t which) const { return quantity_at_[static_cast<std::size_t>(b)][which]; }

    // The auras this building provides, so a tile providing none can be
    // skipped in that pass.
    std::uint32_t aurasProvidedBy(Building b) const { return provides_[static_cast<std::size_t>(b)]; }

    /* Which auras apply to a given quantity, as a bit per aura, so that
       multiplying a value iterates over those alone rather than all eight. */
    std::uint32_t aurasThatMultiply(Game::Quantity quantity, Game::RateOrCapacity rateOrCapacity) const
    {
        return multiply_[static_cast<std::size_t>(quantity)][static_cast<std::size_t>(rateOrCapacity)];
    }

    static constexpr std::uint32_t bit(Building b) { return 1u << static_cast<std::uint32_t>(b); }
    static constexpr std::uint32_t bit(Terrain t) { return 1u << static_cast<std::uint32_t>(t); }

    double marketTax() const { return market_tax_; }

private:
    explicit Rules(const Game::Config& config);

    const Game::Config* game_;

    std::array<const Game::Building*, Enum::Count<Building>> describes_{};
    std::array<Game::Shape, Enum::Count<Building>> shape_{};
    std::array<std::span<const Game::Effect>, Enum::Count<Building>> effects_{};
    std::array<std::array<int, MaxEffects>, Enum::Count<Building>> aura_of_{};
    std::array<std::array<std::uint32_t, MaxEffects>, Enum::Count<Building>> targets_{};
    std::array<std::array<std::uint8_t, MaxEffects>, Enum::Count<Building>> running_total_of_effect_{};
    std::array<std::array<QuantityAndRateOrCapacity, MaxEffects>, Enum::Count<Building>> quantity_at_{};
    std::array<std::uint8_t, Enum::Count<Building>> running_total_count_{};
    std::vector<Aura> auras_;
    std::array<std::array<std::uint32_t, Enum::Count<Game::RateOrCapacity>>, Enum::Count<Game::Quantity>> multiply_{};
    std::array<std::uint32_t, Enum::Count<Building>> provides_{};
    double market_tax_ = 0.0;
};

Output runEffects(const Rules& rules, const GameModifiers& modifiers, const Village& village, ProductionDetail* detail = nullptr, AuraDetail* auras = nullptr);

} // namespace Factions
