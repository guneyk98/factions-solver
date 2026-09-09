#include "effects.hpp"

#include <algorithm>
#include <bit>
#include <format>
#include <map>
#include <mutex>

namespace Factions {

namespace {

/* The village centre is absent from the api, so it has no category there
   either, and the town hall's aura targets a category rather than a list of
   names. Without this the centre would be the one economic building an
   adjacent town hall did nothing for, which contradicts the engine's
   behaviour before it read any game data. Unverified in game: place a town
   hall beside the centre and check whether its wood per tick increases. */
constexpr std::string_view CentreCategory = "ECONOMY";

/* The api names more quantities than this engine counts: knight and guardian
   recruits, market and build orders, and six world-map ratings. Only the four
   resources reach an Output. */
std::optional<Resource> resourceFor(Game::Quantity quantity)
{
    switch (quantity) {
    case Game::Quantity::Wood: return Resource::Wood;
    case Game::Quantity::Iron: return Resource::Iron;
    case Game::Quantity::Workers: return Resource::Workers;
    case Game::Quantity::Soldiers: return Resource::Soldiers;
    default: return std::nullopt;
    }
}

/* The world ratings a building contributes to, as shares rather than as
   anything produced or stored. Efficiency::Worker has no building source. */
std::optional<Efficiency> efficiencyFor(Game::Quantity quantity)
{
    switch (quantity) {
    case Game::Quantity::Attack: return Efficiency::Attack;
    case Game::Quantity::Defense: return Efficiency::Defense;
    case Game::Quantity::MapEfficiency: return Efficiency::Map;
    case Game::Quantity::WorkerProjectEfficiency: return Efficiency::Projects;
    default: return std::nullopt;
    }
}

// Game::RateOrCapacity has a third value, Both, which resolves to Rate here:
// an aura over both is applied when the rate is multiplied.
RateOrCapacity resolveRateOrCapacity(Game::RateOrCapacity rateOrCapacity)
{
    return rateOrCapacity == Game::RateOrCapacity::Capacity ? RateOrCapacity::Capacity : RateOrCapacity::Rate;
}

bool listContains(std::span<const std::string_view> list, std::string_view name)
{
    return std::ranges::find(list, name) != list.end();
}

/* Every building or terrain an effect's `on` list names, as a bit mask. An
   empty list means all of them, which is how the api writes an aura over every
   neighbour. */
std::uint32_t targetMaskOf(const Game::Config& config, const Game::Effect& effect)
{
    std::uint32_t mask = 0;

    if (effect.where == Game::Where::Terrain) {
        for (const Terrain terrain : Enum::values<Terrain>())
            if (effect.on.empty() || listContains(effect.on, Terrains::toId(terrain)))
                mask |= Rules::bit(terrain);
        return mask;
    }

    for (const Game::Building& described : config.buildings) {
        const auto building = Buildings::tryFromId(described.name);
        if (!building.has_value())
            continue;
        if (effect.on.empty() || listContains(effect.on, effect.byCategory ? described.category : described.name))
            mask |= Rules::bit(*building);
    }

    // The centre is in no game's building list, so it is added separately.
    if (effect.on.empty() || (effect.byCategory && listContains(effect.on, CentreCategory)))
        mask |= Rules::bit(Building::VillageCentre);

    return mask;
}

// A factor's share is factor - 1; a share is already one.
double auraShareOf(const Game::Effect& effect)
{
    return effect.amount == Game::Amount::Multiply ? effect.value - 1.0 : effect.value;
}

} // namespace

int Rules::auraSlotOfEffect(Building building, std::size_t nth) const
{
    const auto& slots = aura_of_[static_cast<std::size_t>(building)];
    return nth < slots.size() ? slots[nth] : -1;
}

namespace {

constexpr std::array<std::string_view, 0> EveryTarget{}; // an empty list matches every neighbour

/* The village centre occupies a tile and produces, but no game's rules
   describe it: the api lists only what a player may build. Written as effects
   so the interpreter reads it like any other building, and in static storage,
   since a span into a Rules about to be moved into the cache would dangle. */
constexpr std::array<Game::Effect, 2> CentreEffects{{
    Game::Effect{Game::Where::Base, Game::Amount::Flat, Game::Quantity::Wood, Game::RateOrCapacity::Rate, Centre::WoodPerTick, false, false, EveryTarget, false},
    Game::Effect{Game::Where::Provides, Game::Amount::Multiply, Game::Quantity::Efficiency, Game::RateOrCapacity::Both, 1.0 + Centre::AuraPerVillageLevel, true, false, EveryTarget, false},
}};

} // namespace

Rules::Rules(const Game::Config& config)
    : game_(&config), market_tax_(config.marketTax)
{
    for (auto& row : aura_of_)
        row.fill(-1);

    // Index each of a building's effects by the running total it adds to.
    const auto indexEffectsByQuantity = [this](Building building, std::span<const Game::Effect> effects) {
        const auto buildingIndex = static_cast<std::size_t>(building);
        for (std::size_t n = 0; n < effects.size() && n < MaxEffects; ++n) {
            const auto quantity = static_cast<std::uint8_t>(effects[n].quantity);
            const auto rateOrCapacity = static_cast<std::uint8_t>(effects[n].rateOrCapacity);

            // Linear search over the few totals this building already has, to
            // reuse the one for this quantity or start another.
            std::size_t totalIndex = 0;
            while (totalIndex < running_total_count_[buildingIndex] && (quantity_at_[buildingIndex][totalIndex].quantity != quantity || quantity_at_[buildingIndex][totalIndex].rateOrCapacity != rateOrCapacity))
                ++totalIndex;

            if (totalIndex == running_total_count_[buildingIndex])
                quantity_at_[buildingIndex][running_total_count_[buildingIndex]++] = QuantityAndRateOrCapacity{quantity, rateOrCapacity};
            running_total_of_effect_[buildingIndex][n] = static_cast<std::uint8_t>(totalIndex);
        }
    };

    {
        const auto buildingIndex = static_cast<std::size_t>(Building::VillageCentre);
        shape_[buildingIndex] = Game::Shape::Single;
        effects_[buildingIndex] = CentreEffects;
        indexEffectsByQuantity(Building::VillageCentre, CentreEffects);
        for (std::size_t n = 0; n < CentreEffects.size(); ++n)
            targets_[buildingIndex][n] = targetMaskOf(config, CentreEffects[n]);
        aura_of_[buildingIndex][1] = 0;
        auras_.push_back(Aura{Building::VillageCentre, Game::Quantity::Efficiency, Game::RateOrCapacity::Both, "VILLAGE_CENTRE"});
    }

    for (const Game::Building& described : config.buildings) {
        const auto building = Buildings::tryFromId(described.name);
        if (!building.has_value())
            continue; // a building this engine has no enum value for

        const auto buildingIndex = static_cast<std::size_t>(*building);
        shape_[buildingIndex] = described.shape;
        effects_[buildingIndex] = described.effects;
        indexEffectsByQuantity(*building, described.effects);

        for (std::size_t n = 0; n < described.effects.size() && n < MaxEffects; ++n) {
            const Game::Effect& effect = described.effects[n];
            targets_[buildingIndex][n] = targetMaskOf(config, effect);

            if (effect.where != Game::Where::Provides)
                continue;

            aura_of_[buildingIndex][n] = static_cast<int>(auras_.size());
            auras_.push_back(Aura{
                *building,
                effect.quantity,
                effect.rateOrCapacity,
                std::format("{} {}", described.name, Game::name(effect.quantity)),
            });
        }
    }

    for (std::size_t auraIndex = 0; auraIndex < auras_.size() && auraIndex < MaxAuras; ++auraIndex)
        if (auras_[auraIndex].rateOrCapacity == Game::RateOrCapacity::Both)
            over_everything_ |= 1u << auraIndex;

    for (std::size_t buildingIndex = 0; buildingIndex < Enum::Count<Building>; ++buildingIndex)
        for (std::size_t n = 0; n < MaxEffects; ++n)
            if (const int slot = aura_of_[buildingIndex][n]; slot >= 0 && static_cast<std::size_t>(slot) < MaxAuras)
                provides_[buildingIndex] |= 1u << slot;

    for (std::size_t quantityIndex = 0; quantityIndex < Enum::Count<Game::Quantity>; ++quantityIndex) {
        for (std::size_t rateOrCapacityIndex = 0; rateOrCapacityIndex < Enum::Count<Game::RateOrCapacity>; ++rateOrCapacityIndex) {
            for (std::size_t auraIndex = 0; auraIndex < auras_.size() && auraIndex < MaxAuras; ++auraIndex) {
                const Aura& aura = auras_[auraIndex];
                if (aura.quantity != Game::Quantity::Efficiency && static_cast<std::size_t>(aura.quantity) != quantityIndex)
                    continue;
                if (aura.rateOrCapacity != Game::RateOrCapacity::Both && static_cast<std::size_t>(aura.rateOrCapacity) != rateOrCapacityIndex)
                    continue;
                multiply_[quantityIndex][rateOrCapacityIndex] |= 1u << auraIndex;
            }
        }
    }
}

const Rules& Rules::of(int game)
{
    static std::mutex guard;
    static std::map<int, Rules> cache;

    const std::lock_guard lock(guard);
    if (const auto found = cache.find(game); found != cache.end())
        return found->second;

    const Game::Config* config = Game::find(game);
    if (config == nullptr)
        config = &Game::all().front();

    return cache.emplace(game, Rules(*config)).first->second;
}

namespace {

/* One quantity accumulated across a building's effects: the base, the shares
   added to it, and the factors multiplying their sum. The three are kept apart
   so the result does not depend on the order the effects are listed in. */
struct RunningTotal {
    double flat;           // the base, before anything scales it
    double perLevelShares; // shares that scale with the building's level
    double flatShares;     // shares that do not
    double multiplier;     // the product of the factors over the shares
    bool fromAdjacency;    // an adjacent building contributed to this

    /* Deliberately left without default member initialisers: a building uses
       only the first runningTotalCount() of MaxEffects slots, and value
       initialising all of them was a fifth of runEffects' whole cost. Only the
       slots about to be used are cleared, by clear() below. */
    constexpr void clear()
    {
        flat = 0.0;
        perLevelShares = 0.0;
        flatShares = 0.0;
        multiplier = 1.0;
        fromAdjacency = false;
    }

    double outputOnItsOwnTile() const { return flat * multiplier * (1.0 + perLevelShares + flatShares); }

    // A base of its own for the shares and factors to multiply.
    bool hasBaseOfItsOwn() const { return flat != 0.0; }
    bool isIdentity() const { return perLevelShares == 0.0 && flatShares == 0.0 && multiplier == 1.0; }

    // With no base of its own, the shares and factors apply to the whole
    // village instead, as one share above 1.
    double villageWideShare() const { return multiplier * (1.0 + perLevelShares + flatShares) - 1.0; }

    double outputOrVillageShare() const
    {
        return hasBaseOfItsOwn() ? outputOnItsOwnTile() : villageWideShare();
    }

    // `scale` is the effect's per-level factor times how many times its
    // condition was met, so a factor accumulates linearly: 1.05 applied three
    // times is 1.15, not 1.05^3.
    void add(const Game::Effect& effect, double value, double scale)
    {
        fromAdjacency = fromAdjacency || effect.where == Game::Where::Adjacent;

        switch (effect.amount) {
        case Game::Amount::Flat: flat += value * scale; break;
        case Game::Amount::Share:
            (effect.perLevel ? perLevelShares : flatShares) += value * scale;
            break;
        case Game::Amount::Multiply: multiplier *= 1.0 + (value - 1.0) * scale; break;
        default: break;
        }
    }
};

// Every quantity one building accumulates, before the auras and the
// modifiers, in the order Rules indexed them.
using RunningTotals = std::array<RunningTotal, MaxEffects>;

/* The set of buildings one effect has already been counted for, as a bit per
   anchor tile. Two multi-tile buildings sharing an edge are adjacent at more
   than one pair of tiles but are still one neighbour, so each is counted the
   first time it is reached and skipped after that. */
class CountedBuildings {
public:
    // Adds the building anchored at `anchor`; returns false if it was already
    // in the set.
    bool add(std::size_t anchor)
    {
        const std::uint64_t bit = std::uint64_t{1} << (anchor % 64);
        std::uint64_t& word = added_[anchor / 64];
        const bool wasThere = (word & bit) != 0;
        word |= bit;
        return !wasThere;
    }

private:
    std::array<std::uint64_t, (Village::Width * Village::Height + 63) / 64> added_{};
};

} // namespace

Output runEffects(const Rules& rules, const GameModifiers& modifiers, const Village& village, ProductionDetail* detail, AuraDetail* auras)
{
    const std::size_t auraCount = std::min(rules.auras().size(), MaxAuras);

    /* Indexed tile-major rather than aura-major: multiplying a value reads all
       of one tile's auras at once, so they belong on one cache line. */
    std::array<std::array<double, MaxAuras>, Village::Width * Village::Height> auraGrid{};

    // The tiles a building covers. Nearly every building is Single, and the
    // early return costs less than computing a footprint.
    const auto tilesCoveredBy = [&](std::size_t i, const Tile& tile) {
        const Game::Shape shape = rules.shapeOf(tile.building);
        if (shape == Game::Shape::Single)
            return std::pair{std::array<std::size_t, MaxFootprint>{i, i, i, i}, std::size_t{1}};

        const auto [x, y] = Village::coordinates(i);
        const Footprint fp = footprintOf(static_cast<int>(x), static_cast<int>(y), shape, tile.orientation);
        std::array<std::size_t, MaxFootprint> cells{i, i, i, i};
        std::size_t count = 0;
        for (const auto& [cx, cy] : fp)
            cells[count++] = Village::index(static_cast<std::size_t>(cx), static_cast<std::size_t>(cy));
        return std::pair{cells, count};
    };

    /* Which building covers each tile, and which tile it is anchored at. A
       multi-tile building is stored only on its anchor; its other tiles hold
       Building::None, so a neighbour test must read these two arrays rather
       than the tiles themselves, or three quarters of a Square is invisible. */
    std::array<std::uint8_t, Village::Width * Village::Height> covering{};
    std::array<std::uint8_t, Village::Width * Village::Height> anchorOf{};
    forEachTile(village, [&](std::size_t i, const Tile& tile) {
        if (tile.building == Building::None)
            return;

        covering[i] = static_cast<std::uint8_t>(tile.building);
        anchorOf[i] = static_cast<std::uint8_t>(i);

        // Nearly every building is one tile, and computing a footprint costs
        // more than the two stores above.
        if (rules.shapeOf(tile.building) == Game::Shape::Single)
            return;

        const auto [x, y] = Village::coordinates(i);
        for (const auto& [cx, cy] : footprintOf(static_cast<int>(x), static_cast<int>(y), rules.shapeOf(tile.building), tile.orientation)) {
            const std::size_t covered = Village::index(static_cast<std::size_t>(cx), static_cast<std::size_t>(cy));
            covering[covered] = static_cast<std::uint8_t>(tile.building);
            anchorOf[covered] = static_cast<std::uint8_t>(i);
        }
    });

    /* The building covering tile `j`, as seen by the building anchored at
       `anchor`. A tile the asking building covers itself is not its neighbour. */
    const auto buildingBeside = [&](std::size_t j, std::size_t anchor) {
        return anchorOf[j] == anchor ? Building::None : static_cast<Building>(covering[j]);
    };

    // The centre stands at the village's level; everything else at its own.
    const auto effectiveLevelOf = [&](const Tile& tile) {
        return effectiveLevel(tile.building == Building::VillageCentre ? village.level : tile.level, tile.seal);
    };

    /* First pass: every aura a building provides to its neighbours. Each
       neighbour receives it once, however many of its tiles are adjacent, and
       never from a building of its own kind.

       It runs twice. The auras that apply to every quantity go first, because
       they multiply what the remaining auras contribute: an obelisk next to a
       furnace increases what that furnace contributes to an adjacent mine. */
    const auto applyAuras = [&](bool overEverythingPass) {
        forEachTile(village, [&](std::size_t i, const Tile& tile) {
            const std::uint32_t providing = rules.aurasProvidedBy(tile.building) & (overEverythingPass ? rules.aurasOverEverything() : ~rules.aurasOverEverything());
            if (providing == 0)
                return;

            const auto effects = rules.effects(tile.building);
            const auto [cells, count] = tilesCoveredBy(i, tile);
            const double level = effectiveLevelOf(tile);

            double aurasOverThisSource = 1.0;
            if (!overEverythingPass) {
                for (std::uint32_t remaining = rules.aurasOverEverything(); remaining != 0; remaining &= remaining - 1) {
                    const auto auraIndex = static_cast<std::size_t>(std::countr_zero(remaining));
                    double shareReachingHere = 0.0;
                    for (std::size_t cell = 0; cell < count; ++cell)
                        shareReachingHere += auraGrid[cells[cell]][auraIndex];
                    aurasOverThisSource *= 1.0 + shareReachingHere;
                }
            }

            for (std::size_t n = 0; n < effects.size(); ++n) {
                const int slot = rules.auraSlotOfEffect(tile.building, n);
                if (slot < 0 || ((providing >> slot) & 1u) == 0)
                    continue;

                const Game::Effect& effect = effects[n];
                const std::uint32_t targets = rules.targetsOfEffect(tile.building, n);
                const double value = auraShareOf(effect) * (effect.perLevel ? level : 1.0) * aurasOverThisSource;

                /* Added once per building reached, however many pairs of tiles
                   are adjacent: a town hall along the side of a market is
                   adjacent to it at two of them. Reading an aura sums the
                   tiles a building covers, so writing to the first tile
                   reached counts it exactly once. */
                CountedBuildings reached;
                for (std::size_t cell = 0; cell < count; ++cell) {
                    forEachNeighbour(cells[cell], [&](std::size_t j) {
                        const auto beside = static_cast<Building>(covering[j]);
                        // An aura never applies to its own kind of building,
                        // which excludes the source itself.
                        if (beside == tile.building || (targets & Rules::bit(beside)) == 0)
                            return;
                        if (!reached.add(anchorOf[j]))
                            return;

                        auraGrid[j][static_cast<std::size_t>(slot)] += value;
                    });
                }
            }
        });
    };

    applyAuras(true);
    applyAuras(false);

    // Every quantity one building accumulates, before the auras over it.
    const auto runningTotalsFor = [&](const Tile& tile, const std::array<std::size_t, MaxFootprint>& cells,
                                      std::size_t count, double level) {
        RunningTotals totals;
        for (std::size_t totalIndex = 0; totalIndex < rules.runningTotalCount(tile.building); ++totalIndex)
            totals[totalIndex].clear();

        const auto effects = rules.effects(tile.building);
        for (std::size_t n = 0; n < effects.size(); ++n) {
            const Game::Effect& effect = effects[n];
            const std::uint32_t targets = rules.targetsOfEffect(tile.building, n);
            const double perLevel = effect.perLevel ? level : 1.0;

            // How many times this effect's condition is met.
            double occurrences = 0.0;

            switch (effect.where) {
            case Game::Where::Base:
                occurrences = 1.0;
                break;

            case Game::Where::Terrain: // once per covered tile of the named terrain
                for (std::size_t cell = 0; cell < count; ++cell)
                    if (targets & Rules::bit(village[cells[cell]].terrain))
                        totals[rules.runningTotalOfEffect(tile.building, n)].add(effect, effect.value, perLevel);
                break;

            case Game::Where::Adjacent: { // once per adjacent building it names
                CountedBuildings counted;
                for (std::size_t cell = 0; cell < count; ++cell)
                    forEachNeighbour(cells[cell], [&](std::size_t j) {
                        if ((targets & Rules::bit(buildingBeside(j, cells[0]))) == 0)
                            return;
                        if (!counted.add(anchorOf[j]))
                            return;

                        occurrences += 1.0;
                    });
            } break;

            default: // Provides was dealt with in the first pass
                break;
            }

            if (effect.where != Game::Where::Terrain && occurrences != 0.0)
                totals[rules.runningTotalOfEffect(tile.building, n)].add(effect, effect.value, perLevel * occurrences);
        }

        return totals;
    };

    /* Applies every aura that reaches this building and this quantity. Auras
       from different sources multiply; the tiles a building covers are summed,
       since each source wrote its contribution to one of them. */
    const auto multipliedByAuras = [&](double value, Game::Quantity quantity, Game::RateOrCapacity rateOrCapacity,
                                       const std::array<std::size_t, MaxFootprint>& cells, std::size_t count) {
        for (std::uint32_t remaining = rules.aurasThatMultiply(quantity, rateOrCapacity); remaining != 0; remaining &= remaining - 1) {
            const auto auraIndex = static_cast<std::size_t>(std::countr_zero(remaining));

            double shareReachingHere = 0.0;
            for (std::size_t cell = 0; cell < count; ++cell)
                shareReachingHere += auraGrid[cells[cell]][auraIndex];
            value *= 1.0 + shareReachingHere;
        }
        return value;
    };

    Output output{};
    if (detail != nullptr) {
        detail->production = {};
        detail->storage = {};
    }

    /* The market's reduction of its own tax, the combat ratings, and the
       shares that apply to the whole village rather than to the tile they
       stand on. The api writes the last as an effect with no flat part (ten
       percent more wood), so the building has no base of its own to multiply. */
    double taxReduction = 0.0;
    std::array<double, Enum::Count<Efficiency>> efficiencyRatings{};
    std::array<std::array<double, Enum::Count<RateOrCapacity>>, Enum::Count<Resource>> sharesFromBuildings{};
    std::array<std::array<double, Enum::Count<RateOrCapacity>>, Enum::Count<Resource>> multipliersFromBuildings{};

    /* Second pass: each building's output on its own tile, before the
       modifiers. The modifiers reduce to one multiplier per resource and per
       rate or capacity, identical for every tile, so they are factored out and
       applied once at the end rather than traversing the board again. */
    forEachTile(village, [&](std::size_t i, const Tile& tile) {
        if (rules.effects(tile.building).empty())
            return;

        const auto [cells, count] = tilesCoveredBy(i, tile);
        const RunningTotals totals = runningTotalsFor(tile, cells, count, effectiveLevelOf(tile));

        for (std::size_t totalIndex = 0; totalIndex < rules.runningTotalCount(tile.building); ++totalIndex) {
            const RunningTotal& running = totals[totalIndex];
            if (running.isIdentity() && !running.hasBaseOfItsOwn())
                continue;

            const Rules::QuantityAndRateOrCapacity accumulated = rules.quantityAt(tile.building, totalIndex);
            const auto quantity = static_cast<Game::Quantity>(accumulated.quantity);
            const auto rateOrCapacity = static_cast<Game::RateOrCapacity>(accumulated.rateOrCapacity);
            const double value = multipliedByAuras(running.outputOrVillageShare(), quantity, rateOrCapacity, cells, count);

            // The tax and the world ratings are never a building's own
            // output: each is a share of a village-wide quantity.
            if (quantity == Game::Quantity::MarketTax) {
                taxReduction -= value; // the api writes the market's cut as a subtraction
                continue;
            }
            if (const std::optional<Efficiency> efficiency = efficiencyFor(quantity)) {
                efficiencyRatings[static_cast<std::size_t>(*efficiency)] += value;
                continue;
            }

            const auto resource = resourceFor(quantity);
            if (!resource.has_value())
                continue; // a quantity this engine does not count

            const auto resourceIndex = static_cast<std::size_t>(*resource);
            const RateOrCapacity rateOrCapacityOfOutput = resolveRateOrCapacity(rateOrCapacity);
            const auto rateOrCapacityIndex = static_cast<std::size_t>(rateOrCapacityOfOutput);

            if (!running.hasBaseOfItsOwn()) {
                /* An adjacency effect multiplies this tile's own output, so
                   with no base of its own there is nothing to multiply: a
                   house next to a guard tower but no barracks stores no
                   soldiers, and adds nothing to any other tile either. */
                if (running.fromAdjacency)
                    continue;

                /* A share joins the village-wide sum; a factor multiplies
                   that sum. They are accumulated separately for that reason.

                   The auras over the source and its seal multiply both, as
                   they would the source's own output. They do not multiply a
                   flat share: a furnace on plains gives the village its ten
                   percent regardless of its neighbours and its seal. */
                const double sealMultiplier = multiplierFromSeal(
                    tile.seal, rateOrCapacityOfOutput == RateOrCapacity::Rate ? Seal::Mill : Seal::Barrel
                );

                sharesFromBuildings[resourceIndex][rateOrCapacityIndex] += multipliedByAuras(running.perLevelShares, quantity, rateOrCapacity, cells, count) * sealMultiplier + running.flatShares;
                multipliersFromBuildings[resourceIndex][rateOrCapacityIndex] += multipliedByAuras(running.multiplier - 1.0, quantity, rateOrCapacity, cells, count) * sealMultiplier;
                continue;
            }

            // A mill multiplies what a tile produces, a barrel what it stores.
            const double onThisTile = value * multiplierFromSeal(tile.seal, rateOrCapacityOfOutput == RateOrCapacity::Rate ? Seal::Mill : Seal::Barrel);

            // Both totals and both grids are indexed by Resource, so the
            // effect's own resource selects the slot without a branch.
            const bool perTick = rateOrCapacityOfOutput == RateOrCapacity::Rate;
            (perTick ? output.production : output.storage)[*resource] += onThisTile;

            if (detail != nullptr)
                (perTick ? detail->production : detail->storage)[*resource][i] += onThisTile;
        }
    });

    /* The modifiers that apply to every tile, reduced to multipliers once.
       Quests scale rates and capacities alike; balance scales rates only. */
    const double questMultiplier = modifiers.quests;
    const double rateMultiplier = questMultiplier * modifiers.balance;

    const auto politicsMultiplier = [&](Politics favoured) {
        return modifiers.politics == favoured ? PoliticsBonus : 1.0;
    };

    // One multiplier per resource, the same for every tile.
    ResourceTotals perTickMultiplier;
    ResourceTotals capacityMultiplier;
    for (const Resource resource : Enum::values<Resource>()) {
        const double politicsMultiplierForResource = resource == Resource::Wood || resource == Resource::Iron
                                                         ? politicsMultiplier(Politics::Resource)
                                                         : (resource == Resource::Workers ? politicsMultiplier(Politics::Worker) : politicsMultiplier(Politics::Soldier));

        const auto resourceIndex = static_cast<std::size_t>(resource);
        const auto perTick = static_cast<std::size_t>(RateOrCapacity::Rate);
        const auto capacity = static_cast<std::size_t>(RateOrCapacity::Capacity);

        perTickMultiplier[resource] = modifiers.forQuantity(resource, RateOrCapacity::Rate).multiplier(sharesFromBuildings[resourceIndex][perTick]) * (1.0 + multipliersFromBuildings[resourceIndex][perTick]) * rateMultiplier * politicsMultiplierForResource;
        capacityMultiplier[resource] = modifiers.forQuantity(resource, RateOrCapacity::Capacity).multiplier(sharesFromBuildings[resourceIndex][capacity]) * (1.0 + multipliersFromBuildings[resourceIndex][capacity]) * questMultiplier;
    }

    /* Terms added to the base rather than scaled by it: the storage every
       village has before anyTarget is built, and whatever the flat sources
       carry. They are added before the multipliers, so they are worth the same
       to an empty village as to a full one. They belong to no tile, so the
       per-tile grids below exclude them. */
    const auto addedBeforeMultiplication = [&](Resource resource, RateOrCapacity rateOrCapacity) {
        const double base = rateOrCapacity == RateOrCapacity::Capacity
                                ? BaseStorage[static_cast<std::size_t>(resource)]
                                : 0.0;
        return base + modifiers.forQuantity(resource, rateOrCapacity).addedBeforeMultiplier();
    };

    // Redistribution is added after every share and factor.
    const auto applyModifiersTo = [&](double& total, Resource resource, RateOrCapacity rateOrCapacity, double multiplier) {
        total = (total + addedBeforeMultiplication(resource, rateOrCapacity)) * multiplier + modifiers.forQuantity(resource, rateOrCapacity).addedAfterMultiplier();
    };

    for (const Resource resource : Enum::values<Resource>()) {
        applyModifiersTo(output.production[resource], resource, RateOrCapacity::Rate, perTickMultiplier[resource]);
        applyModifiersTo(output.storage[resource], resource, RateOrCapacity::Capacity, capacityMultiplier[resource]);
    }

    if (detail != nullptr) {
        const auto scaleGrid = [](TileGrid& auraGrid, double by) {
            for (double& one : auraGrid)
                one *= by;
        };
        for (const Resource resource : Enum::values<Resource>()) {
            scaleGrid(detail->production[resource], perTickMultiplier[resource]);
            scaleGrid(detail->storage[resource], capacityMultiplier[resource]);
        }
    }

    for (const Efficiency efficiency : Enum::values<Efficiency>()) {
        const auto efficiencyIndex = static_cast<std::size_t>(efficiency);
        const ModifierSet& set = modifiers.forQuantity(efficiency);
        const double quests = Efficiencies::scaledByQuests(efficiency) ? questMultiplier : 1.0;
        output.efficiency[efficiencyIndex] = set.multiplier(efficiencyRatings[efficiencyIndex]) * quests + set.addedAfterMultiplier() - 1;
    }

    output.market.tax = std::max(0.0, rules.marketTax() - modifiers.marketTaxReduction - taxReduction);
    output.market.wood = output.production[Resource::Wood] * (1 - output.market.tax);
    output.market.iron = output.production[Resource::Iron] * (1 - output.market.tax);

    if (auras != nullptr) {
        auras->sources.assign(rules.auras().begin(), rules.auras().begin() + static_cast<long>(auraCount));
        // The page wants one grid per aura, so transpose. Only ever done for
        // the single village on screen.
        auras->grid.assign(auraCount, TileGrid{});
        for (std::size_t auraIndex = 0; auraIndex < auraCount; ++auraIndex)
            for (std::size_t tileIndex = 0; tileIndex < auraGrid.size(); ++tileIndex)
                auras->grid[auraIndex][tileIndex] = auraGrid[tileIndex][auraIndex];
    }

    if (detail != nullptr) {
        // The page displays these as bonuses, so multiplier - 1.
        for (const Resource resource : Enum::values<Resource>()) {
            detail->global.production[resource] = perTickMultiplier[resource] - 1;
            detail->global.storage[resource] = capacityMultiplier[resource] - 1;
        }
    }

    return output;
}

} // namespace Factions
