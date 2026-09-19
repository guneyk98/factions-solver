#include "simulate.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <format>
#include <map>
#include <mutex>
#include <utility>

namespace Factions {

namespace Simulate {
namespace {

constexpr std::array<std::string_view, Enum::Count<Action>> ActionIds{
    "build", "upgrade", "destroy", "move", "village", "seal", "unseal"
};
static_assert(Enum::allDifferent(ActionIds), "each action needs an id of its own");

// The resources a cost is written in, in the order a message lists them.
constexpr std::array<Resource, 3> Spendable{Resource::Wood, Resource::Iron, Resource::Workers};

double& component(Cost::Resources& cost, Resource resource)
{
    switch (resource) {
    case Resource::Wood:
        return cost.wood;
    case Resource::Iron:
        return cost.iron;
    default:
        return cost.workers;
    }
}

double amountOf(const Cost::Resources& cost, Resource resource)
{
    return component(const_cast<Cost::Resources&>(cost), resource);
}

Cost::Resources scaledBy(const Cost::Resources& cost, double by)
{
    return Cost::Resources{cost.wood * by, cost.iron * by, cost.workers * by};
}

std::string coordinates(std::size_t tile)
{
    const auto [x, y] = Village::coordinates(tile);
    return std::format("({}, {})", x, y);
}

} // namespace

std::string_view name(Action action)
{
    return ActionIds[static_cast<std::size_t>(action)];
}

std::optional<Action> actionFromName(std::string_view name)
{
    return Enum::find<Action>(ActionIds, name);
}

Costs::Costs(const Game::Config& game, int season)
    : upgrade_(Enum::Count<Building> * LevelCount), village_(LevelCount)
{
    for (const Building building : Enum::values<Building>()) {
        build_[static_cast<std::size_t>(building)] = Cost::totalToLevel(game, building, 1, season);
        for (int level = 1; level < MaxLevel; ++level)
            upgrade_[rowOf(building, level)] = Cost::toNextLevel(game, building, level, season);
    }

    for (int level = 1; level < MaxLevel; ++level)
        village_[static_cast<std::size_t>(level)] = Cost::villageToNextLevel(game, level, season);
}

const Costs& Costs::of(const Game::Config& game, int season)
{
    static std::mutex guard;
    static std::map<std::pair<int, int>, Costs> cache;

    const std::lock_guard lock(guard);
    const std::pair key{game.id, season};
    if (const auto found = cache.find(key); found != cache.end())
        return found->second;

    return cache.emplace(key, Costs(game, season)).first->second;
}

const Cost::Resources& Costs::toNextLevel(Building building, int level) const
{
    static constexpr Cost::Resources nothing{};
    if (level < 1 || level >= MaxLevel)
        return nothing;

    assert(rowOf(building, level) < upgrade_.size());
    return upgrade_[rowOf(building, level)];
}

Cost::Resources Costs::totalToLevel(Building building, int level) const
{
    if (level < 1)
        return Cost::Resources{};

    Cost::Resources total = toBuild(building);
    for (int at = 1; at < level; ++at) {
        const Cost::Resources& more = toNextLevel(building, at);
        total.wood += more.wood;
        total.iron += more.iron;
        total.workers += more.workers;
    }
    return total;
}

const Cost::Resources& Costs::villageToNextLevel(int level) const
{
    static constexpr Cost::Resources nothing{};
    if (level < 1 || level >= MaxLevel)
        return nothing;
    return village_[static_cast<std::size_t>(level)];
}

Simulation::Simulation(const Rules& rules, const GameModifiers& modifiers, const Village& start, const Setup& setup)
    : rules_{&rules}, modifiers_{&modifiers}, village_{start}, stock_{setup.stock}, tick_{setup.tick}, tier_{setup.tier}
{
    season_ = tick_ / TicksPerSeason;
    costs_ = &Costs::of(rules.game(), season_);

    // An attached seal and a stored one are the same seal, so both are entries.
    for (std::size_t i = 0; i < NoTile && sealCount_ < MaxSeals; ++i)
        if (village_[i].seal != Seal::None)
            seals_[sealCount_++] = SealHeld{village_[i].seal, i, tick_};

    for (const Seal kind : Enum::values<Seal>()) {
        if (kind == Seal::None)
            continue;
        for (int n = 0; n < setup.sealsStored[static_cast<std::size_t>(kind)] && sealCount_ < MaxSeals; ++n)
            seals_[sealCount_++] = SealHeld{kind, NoTile, tick_};
    }

    recomputeOutput();
    assert(sealsConsistent());
}

void Simulation::recomputeOutput()
{
    output_ = runEffects(*rules_, *modifiers_, village_);

    recycling_ = 0.0;
    for (std::size_t i = 0; i < NoTile; ++i) {
        const Tile& tile = village_[i];
        if (tile.building == Building::None)
            continue;

        for (const Game::Effect& effect : rules_->effects(tile.building))
            if (effect.quantity == Game::Quantity::Recycling)
                recycling_ += effect.value * (effect.perLevel ? tile.level : 1);
    }

    recycling_ = std::clamp(recycling_, 0.0, 1.0);
}

void Simulation::useCostsForSeason()
{
    const int season = tick_ / TicksPerSeason;
    if (season == season_)
        return;

    season_ = season;
    costs_ = &Costs::of(rules_->game(), season_);
}

void Simulation::advanceBy(int ticks)
{
    if (ticks <= 0)
        return;

    const auto grow = [ticks](double stored, double rate, double capacity) {
        if (stored >= capacity)
            return stored;
        return std::min(stored + rate * ticks, capacity);
    };

    for (const Resource resource : Enum::values<Resource>())
        stock_[resource] = grow(stock_[resource], output_.production[resource], output_.storage[resource]);

    for (const Unit unit : Enum::values<Unit>()) {
        const auto which = static_cast<std::size_t>(unit);
        stock_.charge[which] = grow(stock_.charge[which], output_.units[which], FullCharge);
    }

    tick_ += ticks;
    useCostsForSeason();
}

void Simulation::advanceTo(int tick)
{
    advanceBy(tick - tick_);
}

bool Simulation::canPay(const Cost::Resources& cost) const
{
    return stock_[Resource::Wood] >= cost.wood && stock_[Resource::Iron] >= cost.iron && stock_[Resource::Workers] >= cost.workers;
}

int Simulation::ticksUntilAffordable(const Cost::Resources& cost) const
{
    int longest = 0;
    for (const Resource resource : Spendable) {
        const double owed = amountOf(cost, resource) - stock_[resource];
        if (owed <= 0.0)
            continue;

        const double rate = output_.production[resource];
        if (rate <= 0.0 || amountOf(cost, resource) > output_.storage[resource])
            return -1;

        longest = std::max(longest, static_cast<int>(std::ceil(owed / rate)));
    }
    return longest;
}

Cost::Resources Simulation::refundForDestroying(Building building, int level) const
{
    if (recycling_ == 0.0)
        return Cost::Resources{};

    // Costed at this season; the levels' own seasons are not recorded.
    return scaledBy(costs_->totalToLevel(building, level), recycling_);
}

bool Simulation::sealsConsistent() const
{
    if (sealCount_ > MaxSeals)
        return false;

    std::array<int, NoTile> onTile{};

    for (std::size_t s = 0; s < sealCount_; ++s) {
        const SealHeld& held = seals_[s];
        if (held.kind == Seal::None || held.readyAt < 0)
            return false;
        if (held.tile == NoTile)
            continue;
        if (held.tile > NoTile)
            return false;

        if (++onTile[held.tile] > 1)
            return false;
        if (village_[held.tile].building == Building::None)
            return false;
        if (village_[held.tile].seal != held.kind)
            return false;
    }

    for (std::size_t i = 0; i < NoTile; ++i)
        if ((village_[i].seal != Seal::None) != (onTile[i] == 1))
            return false;

    return true;
}

std::size_t Simulation::sealOn(std::size_t tile) const
{
    for (std::size_t s = 0; s < sealCount_; ++s)
        if (seals_[s].tile == tile)
            return s;
    return sealCount_;
}

State Simulation::state() const
{
    State state;
    state.tick = tick_;
    state.season = season_;
    state.villageLevel = village_.level;
    state.stock = stock_;
    state.production = output_.production;
    state.capacity = output_.storage;
    state.unitProduction = output_.units;
    state.recycling = recycling_;

    for (std::size_t i = 0; i < NoTile; ++i)
        state.slotsUsed += Buildings::slots(village_[i].building);

    for (std::size_t s = 0; s < sealCount_; ++s) {
        if (seals_[s].tile != NoTile)
            continue;

        const auto kind = static_cast<std::size_t>(seals_[s].kind);
        if (state.sealsStored[kind]++ == 0 || seals_[s].readyAt < state.sealReadyAt[kind])
            state.sealReadyAt[kind] = seals_[s].readyAt;
    }

    return state;
}

namespace {

std::optional<std::string> missingAdjacentTerrain(const Village& village, const Game::Building& described, const Footprint& footprint)
{
    if (described.needsAdjacentTerrain.empty())
        return std::nullopt;

    const auto named = [&described](Terrain terrain) {
        return std::ranges::contains(described.needsAdjacentTerrain, Terrains::toId(terrain));
    };

    bool covered = false;
    for (const auto& [x, y] : footprint) {
        if (!isInside(x, y))
            continue;

        forEachNeighbour(Village::index(static_cast<std::size_t>(x), static_cast<std::size_t>(y)), [&](std::size_t beside) {
            const auto [bx, by] = Village::coordinates(beside);
            const bool inFootprint = std::ranges::any_of(footprint, [bx = static_cast<int>(bx), by = static_cast<int>(by)](const auto& own) { return own.first == bx && own.second == by; });
            if (!inFootprint && named(village[beside].terrain))
                covered = true;
        });
    }

    if (covered)
        return std::nullopt;

    std::string ground;
    for (const std::string_view one : described.needsAdjacentTerrain)
        ground += (ground.empty() ? "" : " or ") + std::string{one};

    return std::format("{} must stand beside {}", described.name, ground);
}

} // namespace

std::optional<std::string> Simulation::apply(Step& step)
{
    if (step.tick < tick_)
        return std::format("a step at tick {} comes after one at tick {}", step.tick, tick_);

    advanceTo(step.tick);

    const Game::Config& game = rules_->game();

    Village after = village_;
    Cost::Resources cost{};
    Cost::Resources back{};
    std::size_t sealMoved = sealCount_;
    std::size_t sealLandsOn = NoTile;
    bool sealStartsCooldown = false;

    const auto terrainRefusal = [&](Building building, std::size_t tile, Orientation orientation) -> std::optional<std::string> {
        const Game::Building* const described = rules_->describes(building);
        if (described == nullptr)
            return std::nullopt;

        const auto [x, y] = Village::coordinates(tile);
        return missingAdjacentTerrain(after, *described, footprintOf(static_cast<int>(x), static_cast<int>(y), rules_->shapeOf(building), orientation));
    };

    switch (step.action) {
    case Action::Build: {
        const Tile& standing = village_[step.tile];
        if (standing.building != Building::None)
            return std::format("{} already holds a {}", coordinates(step.tile), Buildings::toId(standing.building));
        if (step.building == Building::None || step.building == Building::VillageCentre)
            return std::format("a {} cannot be built", Buildings::toId(step.building));

        const Buildings::Info& info = Buildings::of(step.building);
        if (info.tier > tier_)
            return std::format("{} is on build-menu tier {}, and tier {} is the highest unlocked", info.id, info.tier, tier_);

        const Game::Building* const described = rules_->describes(step.building);
        if (described == nullptr)
            return std::format("this round has no {}", info.id);
        if (village_.level < described->hq)
            return std::format("{} needs village level {}, and the village is at {}", info.id, described->hq, village_.level);

        cost = costs_->toBuild(step.building);

        Tile& tile = after[step.tile];
        tile.building = step.building;
        tile.level = 1;
        tile.orientation = step.orientation;
        tile.seal = Seal::None;
        step.level = 1;
        step.seal = Seal::None;

        if (std::optional<std::string> wrong = terrainRefusal(step.building, step.tile, step.orientation))
            return wrong;
        break;
    }

    case Action::Upgrade: {
        const Tile& standing = village_[step.tile];
        if (standing.building == Building::None)
            return std::format("nothing stands at {} to upgrade", coordinates(step.tile));
        if (standing.building == Building::VillageCentre)
            return "a village centre follows the village level";

        const Game::Building* const described = rules_->describes(standing.building);
        if (described != nullptr && !described->upgradeable)
            return std::format("{} never leaves level 1", Buildings::toId(standing.building));
        if (standing.level >= Buildings::maxLevel(standing.building))
            return std::format("{} at {} is already at its highest level, {}", Buildings::toId(standing.building), coordinates(step.tile), Buildings::maxLevel(standing.building));

        cost = costs_->toNextLevel(standing.building, standing.level);
        after[step.tile].level = standing.level + 1;
        step.building = standing.building;
        step.level = standing.level + 1;
        step.seal = standing.seal;
        break;
    }

    case Action::Destroy: {
        const Tile& standing = village_[step.tile];
        if (standing.building == Building::None)
            return std::format("nothing stands at {} to destroy", coordinates(step.tile));
        if (standing.building == Building::VillageCentre)
            return "a village centre cannot be destroyed";

        back = refundForDestroying(standing.building, standing.level);
        step.building = standing.building;
        step.seal = standing.seal;
        step.level = 0;

        sealMoved = sealOn(step.tile);
        sealLandsOn = NoTile;

        after[step.tile] = Tile{standing.terrain};
        break;
    }

    case Action::Move: {
        if (step.from >= NoTile)
            return "a move needs the tile it starts from";

        const Tile& standing = village_[step.from];
        if (standing.building == Building::None)
            return std::format("nothing stands at {} to move", coordinates(step.from));
        if (step.tile != step.from && village_[step.tile].building != Building::None)
            return std::format("{} already holds a {}", coordinates(step.tile), Buildings::toId(village_[step.tile].building));

        after[step.from] = Tile{standing.terrain};
        Tile& moved = after[step.tile];
        const Terrain ground = moved.terrain;
        moved = standing;
        moved.terrain = ground;
        moved.orientation = step.orientation;

        sealMoved = sealOn(step.from);
        sealLandsOn = step.tile;

        step.building = standing.building;
        step.level = standing.level;
        step.seal = standing.seal;

        if (std::optional<std::string> wrong = terrainRefusal(standing.building, step.tile, step.orientation))
            return wrong;
        break;
    }

    case Action::UpgradeVillage: {
        if (village_.level >= MaxLevel)
            return std::format("a village stops at level {}", MaxLevel);

        cost = costs_->villageToNextLevel(village_.level);
        after.level = village_.level + 1;
        step.building = Building::VillageCentre;
        step.level = after.level;
        step.tile = NoTile;
        break;
    }

    case Action::AttachSeal: {
        const Tile& standing = village_[step.tile];
        if (step.seal == Seal::None)
            return "a seal step needs the seal to attach";
        if (standing.building == Building::None)
            return std::format("nothing stands at {} to attach a seal to", coordinates(step.tile));
        if (standing.seal != Seal::None)
            return std::format("{} at {} already holds a {} seal", Buildings::toId(standing.building), coordinates(step.tile), Seals::toId(standing.seal));
        if (!Buildings::takesSeal(standing.building, step.seal))
            return std::format("a {} seal does not fit a {}", Seals::toId(step.seal), Buildings::toId(standing.building));

        const Game::Building* const described = rules_->describes(standing.building);
        if (described != nullptr && !described->takesModules)
            return std::format("a {} accepts no seal in this round", Buildings::toId(standing.building));

        std::size_t soonest = sealCount_;
        int stored = 0;
        for (std::size_t s = 0; s < sealCount_; ++s) {
            if (seals_[s].tile != NoTile || seals_[s].kind != step.seal)
                continue;
            ++stored;
            if (soonest == sealCount_ || seals_[s].readyAt < seals_[soonest].readyAt)
                soonest = s;
        }

        if (stored == 0)
            return std::format("no {} seal is in storage", Seals::toId(step.seal));
        if (seals_[soonest].readyAt > tick_)
            return std::format("the {} seal is on cooldown until tick {}, and it is tick {}", Seals::toId(step.seal), seals_[soonest].readyAt, tick_);

        sealMoved = soonest;
        sealLandsOn = step.tile;
        sealStartsCooldown = true;

        after[step.tile].seal = step.seal;
        step.building = standing.building;
        step.level = standing.level;
        break;
    }

    case Action::DetachSeal: {
        const Tile& standing = village_[step.tile];
        if (standing.seal == Seal::None)
            return std::format("no seal is attached at {}", coordinates(step.tile));

        sealMoved = sealOn(step.tile);
        sealLandsOn = NoTile;

        after[step.tile].seal = Seal::None;
        step.building = standing.building;
        step.level = standing.level;
        step.seal = standing.seal;
        break;
    }

    default:
        return "no such step";
    }

    if (!canPay(cost))
        return std::format("a {} at tick {} costs {:.0f} wood, {:.0f} iron and {:.0f} workers; the village holds {:.0f}, {:.0f} and {:.0f}", name(step.action), step.tick, cost.wood, cost.iron, cost.workers, stock_[Resource::Wood], stock_[Resource::Iron], stock_[Resource::Workers]);

    if (const std::optional<std::string> wrong = validate(after, game))
        return wrong;
    if (const std::optional<std::string> wrong = standingOnImpossibleGround(after, game))
        return wrong;

    village_ = after;

    if (sealMoved < sealCount_) {
        seals_[sealMoved].tile = sealLandsOn;
        if (sealStartsCooldown)
            seals_[sealMoved].readyAt = tick_ + SealCooldownTicks;
    }

    for (const Resource resource : Spendable) {
        stock_[resource] -= amountOf(cost, resource);
        stock_[resource] += amountOf(back, resource);
    }

    step.paid = cost;
    step.refunded = back;
    recomputeOutput();
    step.after = state();

    assert(sealsConsistent());
    assert(stock_[Resource::Wood] >= 0.0 && stock_[Resource::Iron] >= 0.0 && stock_[Resource::Workers] >= 0.0);

    return std::nullopt;
}

Report replay(const Rules& rules, const GameModifiers& modifiers, const Village& start, const Setup& setup, std::span<const Step> steps, int until)
{
    Simulation simulation{rules, modifiers, start, setup};

    Report report;
    report.start = simulation.state();
    report.steps.reserve(steps.size());

    for (std::size_t s = 0; s < steps.size(); ++s) {
        Step step = steps[s];
        if (std::optional<std::string> wrong = simulation.apply(step)) {
            report.refusal = std::move(*wrong);
            report.refusedAt = s;
            break;
        }
        report.steps.push_back(step);
    }

    simulation.advanceTo(until);

    report.village = simulation.village();
    report.end = simulation.state();
    return report;
}

} // namespace Simulate

} // namespace Factions
