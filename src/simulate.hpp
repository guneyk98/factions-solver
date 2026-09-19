#pragma once

#include "cost.hpp"
#include "effects.hpp"
#include "game.hpp"
#include "village.hpp"

#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <vector>

/* A village played forward in time rather than arranged: what it comes to when
   every cost has to be produced before it can be paid.

   Construction takes no time, so a tick is the only clock. A tick adds
   production up to the capacity; a store already above capacity keeps what it
   holds and gains nothing, which is why destroying a storehouse stops a
   resource growing without subtracting what is stored.

   None of this is on the path runEffects walks for the rearrange solver. */
namespace Factions {

namespace Simulate {

// A season is a fixed number of ticks, so the season at a tick is
// tick / TicksPerSeason.
inline constexpr int TicksPerSeason = 3240;

// Ticks after a seal is attached before that seal may be attached again.
// Detaching it, or destroying the building under it, does not start this.
inline constexpr int SealCooldownTicks = 100;

// Knights and guardians charge to one whole unit rather than accumulating.
inline constexpr double FullCharge = 100.0;

// Build-menu tiers. Unlocking one unlocks every tier below it.
inline constexpr int TierCount = 4;

// The most seals one simulation tracks, attached and stored together.
inline constexpr std::size_t MaxSeals = 32;

// The index no tile has, which is where a stored seal sits.
inline constexpr std::size_t NoTile = Village::Width * Village::Height;

struct Stock {
    ResourceTotals resource{};
    std::array<double, Enum::Count<Unit>> charge{};

    constexpr double& operator[](Resource which) { return resource[which]; }
    constexpr double operator[](Resource which) const { return resource[which]; }
};

// What a village holds on the first tick of a round.
inline constexpr Stock StartingStock{ResourceTotals{{500.0, 500.0, 0.0, 0.0}}, {}};

/* One seal the player owns. Seals come from modules rather than from anything
   a village produces, so a simulation is told how many are held. */
struct SealHeld {
    Seal kind = Seal::None;
    std::size_t tile = NoTile; // NoTile while stored
    int readyAt = 0;           // the first tick it may be attached on
};

// Stored seals by kind, in Seal order. The Seal::None entry is unused.
using SealCounts = std::array<int, Enum::Count<Seal>>;

// Where a run begins. A run from the first tick and a run from a village
// already standing differ only in this.
struct Setup {
    int tick = 0;
    Stock stock = StartingStock;
    SealCounts sealsStored{};
    int tier = TierCount; // the highest build-menu tier unlocked
};

enum class Action {
    Build,          // at level 1
    Upgrade,        // by one level
    Destroy,        // refunding only what recycling returns
    Move,           // free, keeping the level and the seal; the centre included
    UpgradeVillage, // the next village level, and the slot it adds
    AttachSeal,     // starts that seal's cooldown
    DetachSeal,     // returns it to storage

    Count // keep last
};

std::string_view name(Action action);
std::optional<Action> actionFromName(std::string_view name);

// What the village came to after a step, so a run can be read at any step
// without replaying it.
struct State {
    int tick = 0;
    int season = 0;
    int villageLevel = 1;
    int slotsUsed = 0;
    Stock stock{};
    ResourceTotals production{};
    ResourceTotals capacity{};
    std::array<double, Enum::Count<Unit>> unitProduction{};
    SealCounts sealsStored{};
    // The first tick a stored seal of each kind may be attached on, the
    // soonest of those held. Unset where none is stored.
    std::array<int, Enum::Count<Seal>> sealReadyAt{};
    // The share of a building's total cost that destroying it returns.
    double recycling = 0.0;
};

/* One step. Several may share a tick, since a tick only limits how much has
   been produced by then. The fields above `level` are the request; the rest
   are filled in when it is applied. */
struct Step {
    int tick = 0;
    Action action = Action::Build;
    std::size_t tile = 0;               // the tile acted on, and for Move the destination
    std::size_t from = NoTile;          // Move only: the tile left
    Building building = Building::None; // read for Build; filled in otherwise
    Orientation orientation = Orientation::East;
    Seal seal = Seal::None; // read for AttachSeal; filled in otherwise

    int level = 0; // the level the tile is left at, 0 once bare
    Cost::Resources paid{};
    Cost::Resources refunded{};
    State after{};
};

/* Build and upgrade costs for one game and one season, looked up rather than
   computed: Cost::toNextLevel calls pow per resource, and a search reads it
   once per candidate step. Referred to by pointer, so copying a Simulation
   copies no costs. */
class Costs {
public:
    // Built on first use and kept.
    static const Costs& of(const Game::Config& game, int season);

    // Zero where there is no such upgrade.
    const Cost::Resources& toNextLevel(Building building, int level) const;
    const Cost::Resources& toBuild(Building building) const { return build_[static_cast<std::size_t>(building)]; }

    // The build plus every upgrade up to `level`, which a refund is a share of.
    Cost::Resources totalToLevel(Building building, int level) const;

    const Cost::Resources& villageToNextLevel(int level) const;

private:
    Costs(const Game::Config& game, int season);

    /* One row of LevelCount costs per building, laid out end to end, where
       entry `level` is the cost of leaving that level. Level 0 is unused.

       On the heap because the table is 60 KB and the WebAssembly stack is
       smaller than that: built as a local it would overflow before reaching
       the cache. */
    static constexpr std::size_t LevelCount = MaxLevel + 1;

    std::size_t rowOf(Building building, int level) const
    {
        return static_cast<std::size_t>(building) * LevelCount + static_cast<std::size_t>(level);
    }

    std::array<Cost::Resources, Enum::Count<Building>> build_{};
    std::vector<Cost::Resources> upgrade_;
    std::vector<Cost::Resources> village_;
};

// A village part way through a run. The output is cached because every wait
// reads it and only a step changes it.
class Simulation {
public:
    Simulation(const Rules& rules, const GameModifiers& modifiers, const Village& start, const Setup& setup);

    const Village& village() const { return village_; }
    const Stock& stock() const { return stock_; }
    const Output& output() const { return output_; }
    const Rules& rules() const { return *rules_; }
    const GameModifiers& modifiers() const { return *modifiers_; }
    int tick() const { return tick_; }
    int season() const { return tick_ / TicksPerSeason; }
    int tier() const { return tier_; }
    const Costs& costs() const { return *costs_; }

    std::span<const SealHeld> seals() const { return {seals_.data(), sealCount_}; }

    /* Production is constant between steps, so `ticks` of it is added in one
       step rather than one tick at a time: a run waiting thousands of ticks
       does so in constant time. */
    void advanceBy(int ticks);
    void advanceTo(int tick);

    bool canPay(const Cost::Resources& cost) const;

    /* The fewest ticks after which the store would hold this cost, or -1 if it
       never would: a resource neither held nor produced, or a cost above the
       storage capacity. */
    int ticksUntilAffordable(const Cost::Resources& cost) const;

    // Nothing without a recycling workshop standing. A refund is added directly
    // rather than produced, so it may take a store above its capacity.
    double recyclingShare() const { return recycling_; }
    Cost::Resources refundForDestroying(Building building, int level) const;

    /* Why the step cannot be taken, or nothing. The simulation is advanced to
       the step's tick either way; nothing else changes when it refuses. Fills
       in the step's level, cost, refund and resulting state when it does not. */
    std::optional<std::string> apply(Step& step);

    State state() const;

private:
    void recomputeOutput();
    void useCostsForSeason(); // the tick crossed a season boundary

    /* Whether the tile a seal sits on and the seal that tile carries still
       agree. Every action that builds, moves, destroys, attaches or detaches
       maintains both, and a mismatch produces wrong output rather than a
       crash. Asserted, so it costs nothing in the shipped build. */
    bool sealsConsistent() const;

    // Which held seal sits on this tile, or sealCount_ when none does.
    std::size_t sealOn(std::size_t tile) const;

    const Rules* rules_;
    const GameModifiers* modifiers_;
    const Costs* costs_;
    Village village_;
    Stock stock_{};
    Output output_{};
    std::array<SealHeld, MaxSeals> seals_{};
    std::size_t sealCount_ = 0;
    double recycling_ = 0.0;
    int tick_ = 0;
    int season_ = 0;
    int tier_ = TierCount;
};

// A run of steps and what it came to, in the order they were taken.
struct Report {
    State start{};
    std::vector<Step> steps;
    /* Why a step was refused and which one. The run stops at the first
       refusal: every later step was written against a village that never
       came about. */
    std::string refusal;
    std::size_t refusedAt = 0;
    Village village; // what stands at the end
    State end{};
};

/* Replays the steps and advances to `until`. Steps must be in non-decreasing
   tick order. An `until` before the last step's tick advances no further than
   that step. */
Report replay(const Rules& rules, const GameModifiers& modifiers, const Village& start, const Setup& setup, std::span<const Step> steps, int until);

} // namespace Simulate

} // namespace Factions
