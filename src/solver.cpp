#include "solver.hpp"

#include "effects.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <random>
#include <vector>

namespace Factions {

namespace Objective {
namespace {
constexpr std::array Table{
    Info{"wood.production", "wood production", [](const Output& output) { return output.production[Resource::Wood]; }},
    Info{"iron.production", "iron production", [](const Output& output) { return output.production[Resource::Iron]; }},
    Info{"workers.production", "worker production", [](const Output& output) { return output.production[Resource::Workers]; }},
    Info{"soldiers.production", "soldier production", [](const Output& output) { return output.production[Resource::Soldiers]; }},
    Info{"wood.storage", "wood storage", [](const Output& output) { return output.storage[Resource::Wood]; }},
    Info{"iron.storage", "iron storage", [](const Output& output) { return output.storage[Resource::Iron]; }},
    Info{"workers.storage", "worker storage", [](const Output& output) { return output.storage[Resource::Workers]; }},
    Info{"soldiers.storage", "soldier storage", [](const Output& output) { return output.storage[Resource::Soldiers]; }},

    // The soldiers above, scaled by attack and defense efficiency.
    Info{"soldiers.production.attack", "effective attack soldier production", [](const Output& output) { return effectiveSoldiers(output, efficiencyOf(output, Efficiency::Attack)); }},
    Info{"soldiers.production.defense", "effective defense soldier production", [](const Output& output) { return effectiveSoldiers(output, efficiencyOf(output, Efficiency::Defense)); }},

    /* The workers above, scaled by worker efficiency, and then by map or
       project efficiency on top of it. */
    Info{"workers.production.worker", "effective worker production", [](const Output& output) { return effectiveWorkers(output, Efficiency::Worker); }},
    Info{"workers.production.map", "effective map worker production", [](const Output& output) { return effectiveWorkers(output, Efficiency::Map); }},
    Info{"workers.production.projects", "effective project worker production", [](const Output& output) { return effectiveWorkers(output, Efficiency::Projects); }},

    // The wood and iron above, less the market tax.
    Info{"wood.production.market", "market wood production", [](const Output& output) { return output.market.wood; }},
    Info{"iron.production.market", "market iron production", [](const Output& output) { return output.market.iron; }},

    Info{"power.support", "base support power", [](const Output& output) { return powerOf(output, Power::Support); }},
    Info{"power.knight", "knight power", [](const Output& output) { return powerOf(output, Power::Knight); }},
    Info{"power.guardian", "guardian power", [](const Output& output) { return powerOf(output, Power::Guardian); }},
};

consteval bool objectivesAreWellFormed()
{
    for (std::size_t a = 0; a < Table.size(); ++a) {
        if (Table[a].id.empty() || Table[a].label.empty())
            return false;
        for (std::size_t b = a + 1; b < Table.size(); ++b)
            if (Table[a].id == Table[b].id || Table[a].label == Table[b].label)
                return false;
    }
    return true;
}

static_assert(objectivesAreWellFormed(), "every goal needs an id and a label of its own");

consteval bool everyObjectiveReadsADistinctQuantity()
{
    Output probe{};
    probe.production = {1, 2, 3, 4};
    probe.storage = {5, 6, 7, 8};
    probe.efficiency = {9, 10, 11, 12, 13};
    probe.power = {14, 15, 16};
    probe.market = {0.5, 11, 12};

    for (std::size_t a = 0; a < Table.size(); ++a)
        for (std::size_t b = a + 1; b < Table.size(); ++b)
            if (Table[a].read(probe) == Table[b].read(probe))
                return false;
    return true;
}

static_assert(everyObjectiveReadsADistinctQuantity(), "two goals read the same quantity");
static_assert(Table.size() == Count, "Objective::Count must match the table");

} // namespace

std::span<const Info> all()
{
    return Table;
}

const Info* find(std::string_view id)
{
    for (const Info& info : Table)
        if (info.id == id)
            return &info;
    return nullptr;
}
} // namespace Objective

namespace {

constexpr std::size_t TileCount = Village::Width * Village::Height;

struct Score {
    std::array<double, Objective::Count> value{};
    std::size_t count = 0;
    double weighted_sum = 0.0;
};

double comparisonScale(double a, double b)
{
    return std::max({std::abs(a), std::abs(b), 1.0});
}

struct ScoreDifference {
    int sign = 0;           // 1 if the first is better, -1 if worse, 0 if equal
    double difference = 0;  // first minus second, on the deciding goal
    double magnitude = 1.0; // that goal's magnitude, so a tolerance can be relative to it
};

ScoreDifference compareLexicographic(const Score& a, const Score& b)
{
    for (std::size_t k = 0; k < a.count; ++k) {
        const double scale = comparisonScale(a.value[k], b.value[k]);
        const double diff = a.value[k] - b.value[k];
        if (std::abs(diff) > 1e-9 * scale)
            return ScoreDifference{diff > 0 ? 1 : -1, diff, scale};
    }
    return ScoreDifference{};
}

ScoreDifference compareWeightedSum(const Score& a, const Score& b)
{
    const double scale = comparisonScale(a.weighted_sum, b.weighted_sum);
    const double diff = a.weighted_sum - b.weighted_sum;
    if (std::abs(diff) > 1e-9 * scale)
        return ScoreDifference{diff > 0 ? 1 : -1, diff, scale};
    return ScoreDifference{};
}

struct PlacedBuilding {
    Building building = Building::None;
    Seal seal = Seal::None;
    int level = 0;
    Orientation orientation = Orientation::East;
    std::size_t anchor = 0;
};

std::vector<PlacedBuilding> placedBuildings(const Village& village)
{
    std::vector<PlacedBuilding> placed;
    for (std::size_t i = 0; i < TileCount; ++i) {
        const Tile& tile = village[i];
        if (tile.building != Building::None)
            placed.push_back(PlacedBuilding{tile.building, tile.seal, tile.level, tile.orientation, i});
    }
    return placed;
}

Village terrainOnly(const Village& village)
{
    Village ground = village;
    for (std::size_t i = 0; i < TileCount; ++i)
        ground[i] = Tile{ground[i].terrain};
    return ground;
}

void writePlacements(Village& village, const Village& ground, const std::vector<PlacedBuilding>& placed)
{
    village = ground;
    for (const PlacedBuilding& one : placed) {
        Tile& tile = village[one.anchor];
        tile.building = one.building;
        tile.seal = one.seal;
        tile.level = one.level;
        tile.orientation = one.orientation;
    }
}

using Occupancy = std::array<int, TileCount>;
constexpr int Unoccupied = -1;

bool mapOccupancy(const Rules& rules, const std::vector<PlacedBuilding>& placed, const Village& ground, Occupancy& occupied)
{
    occupied.fill(Unoccupied);

    for (std::size_t p = 0; p < placed.size(); ++p) {
        const PlacedBuilding& one = placed[p];
        const auto [x, y] = Village::coordinates(one.anchor);

        for (const auto& [cx, cy] : footprintOf(static_cast<int>(x), static_cast<int>(y), rules.shapeOf(one.building), one.orientation)) {
            if (!isInside(cx, cy))
                return false;

            const std::size_t ci = Village::index(static_cast<std::size_t>(cx), static_cast<std::size_t>(cy));
            if (occupied[ci] != Unoccupied || !Terrains::buildable(ground[ci].terrain))
                return false;
            occupied[ci] = static_cast<int>(p);
        }
    }
    return true;
}

/* The orientations this shape takes other than `current`: a Line takes East
   and South only, so there is one; an LShape takes all four quarter-turns, so
   there are three. Never called for a Square (excluded from rotatable_) or a
   Single (orientation does not affect either). */
std::array<Orientation, 3> otherOrientationsOf(Game::Shape shape, Orientation current, std::size_t& count)
{
    std::array<Orientation, 3> out{};
    count = 0;
    if (shape == Game::Shape::Line) {
        out[count++] = current == Orientation::South ? Orientation::East : Orientation::South;
        return out;
    }
    for (const Orientation o : {Orientation::East, Orientation::South, Orientation::West, Orientation::North})
        if (o != current)
            out[count++] = o;
    return out;
}

// A separate random stream per restart, hashed so consecutive restarts do not
// produce correlated sequences.
std::uint64_t seedForRestart(std::uint64_t seed, int restart)
{
    std::uint64_t z = seed + 0x9E3779B97F4A7C15ull * static_cast<std::uint64_t>(restart + 1);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

class Search {
public:
    Search(const Rules& rules, const GameModifiers& modifiers, const Village& village, std::span<const Goal> goals, Ranking ranking, std::span<const double> bestAlone, SearchLimits limits)
        : rules_(rules), modifiers_(modifiers), goals_(goals), ranking_(ranking), best_alone_(bestAlone), limits_(limits), terrain_(terrainOnly(village)), initial_(placedBuildings(village)), rng_(limits.seed)
    {

        for (std::size_t p = 0; p < initial_.size(); ++p) {
            // A Square looks the same in every orientation, so trying one is
            // wasted; only a Line or an LShape is worth turning.
            const Game::Shape shape = rules_.shapeOf(initial_[p].building);
            if (shape == Game::Shape::Line || shape == Game::Shape::LShape)
                rotatable_.push_back(p);
            if (initial_[p].seal != Seal::None)
                ++sealed_count_;
        }

        for (std::size_t i = 0; i < TileCount; ++i)
            if (Terrains::buildable(terrain_[i].terrain))
                buildable_tiles_.push_back(i);

        working_ = terrain_;
        written_anchors_.reserve(initial_.size());
    }

    SearchResult run()
    {
        SearchResult result;
        const Score initial_score = score(initial_);

        std::vector<PlacedBuilding> best = initial_;
        Score best_score = initial_score;

        const int last = limits_.restartCount > 0
                             ? std::min(limits_.firstRestart + limits_.restartCount, limits_.restarts)
                             : limits_.restarts;

        for (int restart = limits_.firstRestart; restart < last; ++restart) {
            std::vector<PlacedBuilding> tried = initial_;
            Score tried_score = initial_score;

            rng_.seed(seedForRestart(limits_.seed, restart));
            evaluated_this_restart_ = 0;

            exploreAcceptingWorse(tried, tried_score);
            improveUntilSettled(tried, tried_score);

            if (compare(tried_score, best_score).sign > 0) {
                best_score = tried_score;
                best = std::move(tried);
            }
        }

        writePlacements(result.village, terrain_, best);
        result.before.assign(initial_score.value.begin(), initial_score.value.begin() + static_cast<std::ptrdiff_t>(initial_score.count));
        result.after.assign(best_score.value.begin(), best_score.value.begin() + static_cast<std::ptrdiff_t>(best_score.count));
        result.evaluated = evaluated_;
        for (std::size_t p = 0; p < best.size(); ++p)
            if (best[p].anchor != initial_[p].anchor || best[p].orientation != initial_[p].orientation || best[p].seal != initial_[p].seal)
                ++result.moved;

        return result;
    }

private:
    Score score(const std::vector<PlacedBuilding>& placed)
    {
        ++evaluated_;
        ++evaluated_this_restart_;
        writeIntoWorking(placed);
        return scoreOf(runEffects(rules_, modifiers_, working_));
    }

    /* working_ still holds the previous arrangement, so only its anchors need
       clearing before the next one is written: an arrangement occupies a few
       dozen tiles, where copying the whole village would write all hundred. */
    void writeIntoWorking(const std::vector<PlacedBuilding>& placed)
    {
        for (const std::size_t anchor : written_anchors_)
            working_[anchor] = Tile{working_[anchor].terrain};
        written_anchors_.clear();

        for (const PlacedBuilding& one : placed) {
            Tile& tile = working_[one.anchor];
            tile.building = one.building;
            tile.seal = one.seal;
            tile.level = one.level;
            tile.orientation = one.orientation;
            written_anchors_.push_back(one.anchor);
        }
    }

    Score scoreOf(const Output& output) const
    {
        Score out;
        out.count = goals_.size();
        for (std::size_t k = 0; k < out.count; ++k) {
            out.value[k] = goals_[k].objective->read(output);

            if (ranking_ == Ranking::WeightedSum && k < best_alone_.size() && best_alone_[k] > 0)
                out.weighted_sum += goals_[k].weight * out.value[k] / best_alone_[k];
        }
        return out;
    }

    ScoreDifference compare(const Score& a, const Score& b) const
    {
        return ranking_ == Ranking::WeightedSum ? compareWeightedSum(a, b) : compareLexicographic(a, b);
    }

    std::size_t randomIndex(std::size_t count)
    {
        return std::uniform_int_distribution<std::size_t>(0, count - 1)(rng_);
    }

    static bool canSwapSeals(const PlacedBuilding& a, const PlacedBuilding& b)
    {
        return Buildings::takesSeal(a.building, b.seal) && Buildings::takesSeal(b.building, a.seal);
    }

    static void relocate(std::vector<PlacedBuilding>& placed, const Occupancy& occupied, std::size_t p, std::size_t tile)
    {
        const int occupant = occupied[tile];
        if (occupant == Unoccupied) {
            placed[p].anchor = tile;
            return;
        }
        std::swap(placed[p].anchor, placed[static_cast<std::size_t>(occupant)].anchor);
    }

    bool changeAtRandom(std::vector<PlacedBuilding>& placed, const Occupancy& occupied)
    {
        const std::size_t choice = randomIndex(10);

        if (choice == 0 && !rotatable_.empty()) {
            PlacedBuilding& turned = placed[rotatable_[randomIndex(rotatable_.size())]];
            std::size_t count = 0;
            const std::array<Orientation, 3> others = otherOrientationsOf(rules_.shapeOf(turned.building), turned.orientation, count);
            turned.orientation = others[randomIndex(count)];
            return true;
        }

        if (choice <= 2 && sealed_count_ > 0 && placed.size() > 1) {
            const std::size_t a = randomIndex(placed.size());
            const std::size_t b = randomIndex(placed.size());
            if (a == b || placed[a].seal == placed[b].seal || !canSwapSeals(placed[a], placed[b]))
                return false;
            std::swap(placed[a].seal, placed[b].seal);
            return true;
        }

        const std::size_t p = randomIndex(placed.size());
        const std::size_t tile = buildable_tiles_[randomIndex(buildable_tiles_.size())];
        if (occupied[tile] == static_cast<int>(p))
            return false;
        relocate(placed, occupied, p, tile);
        return true;
    }

    /* Simulated annealing over random changes. A change that scores better is
       always accepted; one that scores worse is accepted with probability
       exp(difference / tolerance), the Metropolis criterion. The tolerance
       decays geometrically from startTolerance to endTolerance across the
       iterations, so early changes can escape a local maximum and later ones
       cannot. It is scaled by the magnitude of the deciding goal, so it means
       the same on a village producing 2 wood as on one producing 200. */
    void exploreAcceptingWorse(std::vector<PlacedBuilding>& best, Score& best_score)
    {
        constexpr double startTolerance = 0.05;
        constexpr double endTolerance = 0.0005;

        std::vector<PlacedBuilding> current = best;
        Score current_score = best_score;
        std::uniform_real_distribution<double> uniform01(0.0, 1.0);

        Occupancy occupied{};
        if (!mapOccupancy(rules_, current, terrain_, occupied))
            return; // the given arrangement overlaps or extends off the grid

        Occupancy fittedOccupancy{};
        std::vector<PlacedBuilding> candidate;

        for (int step = 0; step < limits_.iterations && evaluated_this_restart_ < limits_.budget; ++step) {
            candidate = current;
            if (!changeAtRandom(candidate, occupied))
                continue;

            if (!mapOccupancy(rules_, candidate, terrain_, fittedOccupancy))
                continue;

            const Score value = score(candidate);
            const ScoreDifference difference = compare(value, current_score);

            if (difference.sign < 0) {
                const double progress = static_cast<double>(step) / limits_.iterations;
                const double tolerance = difference.magnitude * startTolerance * std::pow(endTolerance / startTolerance, progress);
                if (uniform01(rng_) >= std::exp(difference.difference / tolerance))
                    continue;
            }

            current = candidate;
            current_score = value;
            occupied = fittedOccupancy;
            if (compare(current_score, best_score).sign > 0) {
                best_score = current_score;
                best = current;
            }
        }
    }

    /* Applies the single best improving change, over and over, until no one
       change improves the score or the budget runs out. */
    void improveUntilSettled(std::vector<PlacedBuilding>& best, Score& best_score)
    {
        for (int pass = 0; pass < limits_.improvementPasses && evaluated_this_restart_ < limits_.budget; ++pass)
            if (!applyBestSingleChange(best, best_score))
                return;
    }

    bool applyBestSingleChange(std::vector<PlacedBuilding>& best, Score& best_score)
    {
        Occupancy occupied{};
        if (!mapOccupancy(rules_, best, terrain_, occupied))
            return false;

        std::vector<PlacedBuilding> bestFound;
        Score bestFoundScore = best_score;
        std::vector<PlacedBuilding> candidate;

        const auto evaluate = [&](const std::vector<PlacedBuilding>& placed) {
            Occupancy fittedOccupancy{};
            if (evaluated_this_restart_ >= limits_.budget || !mapOccupancy(rules_, placed, terrain_, fittedOccupancy))
                return;
            const Score value = score(placed);
            if (compare(value, bestFoundScore).sign > 0) {
                bestFoundScore = value;
                bestFound = placed;
            }
        };

        for (std::size_t p = 0; p < best.size(); ++p) {
            for (const std::size_t tile : buildable_tiles_) {
                if (occupied[tile] == static_cast<int>(p))
                    continue;
                candidate = best;
                relocate(candidate, occupied, p, tile);
                evaluate(candidate);
            }
        }

        for (const std::size_t p : rotatable_) {
            std::size_t count = 0;
            const std::array<Orientation, 3> others = otherOrientationsOf(rules_.shapeOf(best[p].building), best[p].orientation, count);
            for (std::size_t o = 0; o < count; ++o) {
                candidate = best;
                candidate[p].orientation = others[o];
                evaluate(candidate);
            }
        }

        if (sealed_count_ > 0) {
            for (std::size_t a = 0; a < best.size(); ++a) {
                for (std::size_t b = a + 1; b < best.size(); ++b) {
                    if (best[a].seal == best[b].seal || !canSwapSeals(best[a], best[b]))
                        continue;
                    candidate = best;
                    std::swap(candidate[a].seal, candidate[b].seal);
                    evaluate(candidate);
                }
            }
        }

        if (bestFound.empty())
            return false;

        best = std::move(bestFound);
        best_score = bestFoundScore;
        return true;
    }

    const Rules& rules_;
    const GameModifiers& modifiers_;
    std::span<const Goal> goals_;
    Ranking ranking_ = Ranking::Lexicographic;
    std::span<const double> best_alone_;
    SearchLimits limits_;

    Village terrain_;
    Village working_;
    std::vector<std::size_t> written_anchors_; // the anchors working_ currently holds
    std::vector<PlacedBuilding> initial_;
    std::vector<std::size_t> rotatable_;
    std::vector<std::size_t> buildable_tiles_;
    std::size_t sealed_count_ = 0;

    std::mt19937_64 rng_;
    long long evaluated_ = 0;              // over the whole run, for the report
    long long evaluated_this_restart_ = 0; // in the current restart, against the budget
};

} // namespace

SearchResult rearrange(const GameModifiers& modifiers, const Village& village, std::span<const Goal> goals, Ranking ranking, SearchLimits limits, int game)
{
    const Rules& rules = Rules::of(game);

    if (goals.empty() || placedBuildings(village).empty()) {
        SearchResult result;
        result.village = village;

        const Output output = runEffects(rules, modifiers, village);
        for (const Goal& goal : goals)
            result.before.push_back(goal.objective->read(output));
        result.after = result.before;
        return result;
    }

    std::vector<double> bestAlone;
    long long spent = 0;

    if (ranking == Ranking::WeightedSum && goals.size() > 1) {
        const SearchLimits probe{
            .restarts = 4,
            .iterations = 15000,
            .improvementPasses = 8,
            .budget = 100000,
            .seed = limits.seed,
        };

        for (const Goal& goal : goals) {
            const std::array<Goal, 1> byItself{Goal{goal.objective, 1.0}};
            const SearchResult found = Search{rules, modifiers, village, byItself, Ranking::Lexicographic, {}, probe}.run();
            bestAlone.push_back(found.after.front());
            spent += found.evaluated;
        }
    } else if (ranking == Ranking::WeightedSum) {
        bestAlone.assign(goals.size(), 1.0);
    }

    SearchResult result = Search{rules, modifiers, village, goals, ranking, bestAlone, limits}.run();
    result.bestAlone = std::move(bestAlone);
    result.evaluated += spent;
    return result;
}

} // namespace Factions
