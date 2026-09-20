#include "parse.hpp"

#include "game.hpp"
#include "effects.hpp"
#include "text.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <limits>
#include <cmath>
#include <format>
#include <optional>
#include <span>
#include <ranges>
#include <system_error>
#include <type_traits>
#include <vector>

namespace Factions {

namespace Parse {

namespace {

constexpr std::size_t TileCount = Village::Width * Village::Height;
// The upper bound accepted for any effort setting.
constexpr long long MaxSetting = 2000000000;

std::unexpected<Error> fail(std::string message)
{
    return std::unexpected{Error{std::move(message)}};
}

// from_chars stops at the first character it cannot parse, so require that it
// reached the end: '3x' is rejected rather than read as 3.
template <typename T>
std::optional<T> number(std::string_view text)
{
    T value{};
    const auto* const last = text.data() + text.size();
    const auto [ptr, ec] = std::from_chars(text.data(), last, value);
    if (ec != std::errc{} || ptr != last)
        return std::nullopt;
    if constexpr (std::is_floating_point_v<T>)
        if (!std::isfinite(value))
            return std::nullopt;
    return value;
}

std::string listed(const auto& names)
{
    std::string out;
    for (const std::string_view name : names)
        out += (out.empty() ? "" : ", ") + std::string{name};
    return out;
}

// One 'name=value' from the body. Every other token describes a tile.
std::optional<Error> takeModifier(GameModifiers& modifiers, std::string_view token, std::size_t eq)
{
    const std::string_view name = token.substr(0, eq);
    const std::string_view text = token.substr(eq + 1);

    // Politics is the one modifier whose value is an enumerator, not a number.
    if (name == PoliticsChoices::Field) {
        const std::optional<Politics> choice = PoliticsChoices::tryFromId(text);
        if (!choice)
            return Error{std::format("unknown politics '{}'; expected one of {}", text, listed(PoliticsChoices::Ids))};
        modifiers.politics = *choice;
        return std::nullopt;
    }

    const std::optional<ModifierIds::Found> field = ModifierIds::find(modifiers, name);
    if (!field)
        return Error{std::format("unknown modifier '{}'", name)};

    const std::optional<double> value = number<double>(text);
    if (!value)
        return Error{std::format("invalid value for modifier '{}' in '{}'", name, token)};
    if (*value < field->minimum)
        return Error{std::format("modifier '{}' must be at least {}, got {}", name, field->minimum, *value)};

    *field->at = *value;
    return std::nullopt;
}

// 'terrain:building:level' followed by any number of flags, distinguished by
// length: one character is an orientation, a longer token is a seal.
std::expected<Tile, Error> takeTile(std::string_view token, std::size_t i)
{
    const std::vector<std::string_view> field = Text::split(token, ':');
    if (field.size() < 3 || field[0].empty())
        return fail(std::format("malformed tile token '{}' at index {}", token, i));

    const std::optional<int> level = number<int>(field[2]);
    if (!level || *level < 0)
        return fail(std::format("invalid tile level in '{}' at index {}", token, i));

    const std::optional<Building> building = Buildings::tryFromId(field[1]);
    if (!building)
        return fail(std::format("unknown building '{}' at index {}", field[1], i));

    Tile tile;
    tile.building = *building;
    tile.level = *level;

    for (const std::string_view flag : std::span{field}.subspan(3)) {
        if (flag.size() == 1) {
            const std::optional<Orientation> parsed = Orientations::tryFromChar(flag[0]);
            if (!parsed)
                return fail(std::format("invalid orientation '{}' in '{}' at index {}", flag, token, i));
            tile.orientation = *parsed;
            continue;
        }

        const std::optional<Seal> parsed = Seals::tryFromId(flag);
        if (!parsed)
            return fail(std::format("unknown seal '{}' in '{}' at index {}", flag, token, i));
        tile.seal = *parsed;
    }

    const std::optional<Terrain> terrain = Terrains::tryFromId(field[0]);
    if (!terrain)
        return fail(std::format("unknown terrain '{}' at index {}", field[0], i));
    tile.terrain = *terrain;

    return tile;
}

} // namespace

std::expected<ParsedVillage, Error> readableVillage(std::string_view text)
{
    GameModifiers modifiers;
    std::vector<std::string_view> layout;
    int game = 0;
    int season = -1;
    double terrainBonusFactor = 1.0;
    std::array<bool, TileCount> terraformed{};

    for (const std::string_view token : Text::words(text)) {
        const std::size_t eq = token.find('=');
        if (eq == std::string_view::npos) {
            layout.push_back(token);
            continue;
        }
        if (token.substr(0, eq) == "game") {
            const std::optional<int> id = number<int>(token.substr(eq + 1));
            if (!id || Game::find(*id) == nullptr)
                return fail(std::format("no game '{}'", token.substr(eq + 1)));
            game = *id;
            continue;
        }
        if (token.substr(0, eq) == "season") {
            const std::optional<int> which = number<int>(token.substr(eq + 1));
            if (!which || *which < 0)
                return fail(std::format("invalid season '{}'", token.substr(eq + 1)));
            season = *which;
            continue;
        }
        if (token.substr(0, eq) == "terrain_bonus_factor") {
            const std::optional<double> factor = number<double>(token.substr(eq + 1));
            if (!factor || !(*factor >= 1.0))
                return fail(std::format("invalid terrain bonus factor '{}', must be at least 1", token.substr(eq + 1)));
            terrainBonusFactor = *factor;
            continue;
        }
        if (token.substr(0, eq) == "terraformed") {
            for (const std::string_view one : Text::split(token.substr(eq + 1), ',')) {
                const std::optional<std::size_t> at = number<std::size_t>(one);
                if (!at || *at >= TileCount)
                    return fail(std::format("invalid terraformed tile '{}', expected an index below {}", one, TileCount));
                terraformed[*at] = true;
            }
            continue;
        }
        if (const std::optional<Error> trouble = takeModifier(modifiers, token, eq))
            return std::unexpected{*trouble};
    }

    if (layout.size() != TileCount + 1)
        return fail(std::format("expected {} tokens, got {}", TileCount + 1, layout.size()));

    Village village;

    const std::optional<int> village_level = number<int>(layout.front());
    if (!village_level || *village_level < 1)
        return fail(std::format("invalid village level '{}', must be at least 1", layout.front()));
    village.level = *village_level;

    village.terrainBonusFactor = terrainBonusFactor;

    for (std::size_t i = 0; i < TileCount; ++i) {
        const std::expected<Tile, Error> tile = takeTile(layout[i + 1], i);
        if (!tile)
            return std::unexpected{tile.error()};
        village[i] = *tile;
        village.setTerraformed(i, terraformed[i]);
    }

    if (std::optional<std::string> trouble = validate(village, Rules::of(game).game()))
        return fail(std::move(*trouble));

    return ParsedVillage{village, modifiers, game, season};
}

std::expected<ParsedVillage, Error> village(std::string_view text)
{
    std::expected<ParsedVillage, Error> parsed = readableVillage(text);
    if (!parsed)
        return parsed;

    if (std::optional<std::string> trouble = standingOnImpossibleGround(parsed->village, Rules::of(parsed->game).game()))
        return fail(std::move(*trouble));

    return parsed;
}

std::expected<Goals, Error> goals(std::string_view spec)
{
    if (spec.empty())
        return fail("no goal given");

    Goals goals;
    std::size_t weighted = 0;
    std::size_t targeted = 0;
    double targets = 0;

    /* 'id', 'id:weight' or 'id=target', each optionally followed by
       '>=minimum'. The minimum is cut off first, so the '=' it carries is
       never taken for a target's. */
    for (const std::string_view term : Text::split(spec, ',')) {
        std::string_view head = term;
        std::string_view minimum;

        const std::size_t least = head.find(">=");
        if (least != std::string_view::npos) {
            minimum = head.substr(least + 2);
            head = head.substr(0, least);
        }

        const std::size_t marked = head.find_first_of(":=");
        const bool target = marked != std::string_view::npos && head[marked] == '=';
        const std::string_view id = head.substr(0, marked);

        double weight = 1.0;
        double atLeast = 0.0;

        if (marked != std::string_view::npos) {
            const std::string_view text = head.substr(marked + 1);
            const std::optional<double> given = number<double>(text);
            if (!given || *given < 0)
                return fail(std::format("goal '{}' has a {} of '{}', which must be a number of at least 0", id, target ? "ratio target" : "weight", text));

            weight = *given;
            if (target) {
                ++targeted;
                targets += weight;
            } else {
                ++weighted;
            }
        }

        if (least != std::string_view::npos) {
            const std::optional<double> given = number<double>(minimum);
            if (!given || *given < 0)
                return fail(std::format("goal '{}' asks for at least '{}', which must be a number of at least 0", id, minimum));
            atLeast = *given;
        }

        const Objective::Info* const info = Objective::find(id);
        if (info == nullptr)
            return fail(std::format("unknown goal '{}'; expected one or more of {}", id, listed(Objective::all() | std::views::transform(&Objective::Info::id))));
        if (std::ranges::any_of(goals.goals, [info](const Goal& goal) { return goal.objective == info; }))
            return fail(std::format("goal '{}' is named twice", id));

        goals.goals.push_back(Goal{info, weight, atLeast});
    }

    if (weighted != 0 && targeted != 0)
        return fail("a goal carries either a weight or a ratio target, not one of each");
    if (weighted != 0 && weighted != goals.goals.size())
        return fail("either every goal carries a weight or none does");
    if (targeted != 0 && targeted != goals.goals.size())
        return fail("either every goal carries a ratio target or none does");
    if (targeted != 0 && targets <= 0)
        return fail("a ratio needs one goal with a target above 0");

    goals.ranking = targeted != 0 ? Ranking::Ratio
        : weighted != 0           ? Ranking::WeightedSum
                                  : Ranking::Lexicographic;
    return goals;
}

std::expected<SearchLimits, Error> effort(std::string_view spec)
{
    SearchLimits limits;

    // Every setting is a non-negative integer parsed the same way; only the
    // field it lands in differs. A budget counts arrangements, so it alone
    // needs the wider type.
    constexpr std::array<std::string_view, 7> names{"restarts", "iterations", "improvementPasses", "budget", "first", "count", "terraform"};

    /* A slice of the restarts may legitimately start at 0 or be empty, and a
       terraform budget of 0 is what leaves the terrain alone. */
    const auto lowerBoundFor = [](std::string_view name) { return name == "first" || name == "count" || name == "terraform" ? 0 : 1; };

    for (const std::string_view term : Text::split(spec, ',')) {
        if (term.empty())
            continue;

        const std::size_t equals = term.find('=');
        if (equals == std::string_view::npos)
            return fail(std::format("'{}' is not a name=value", term));

        const std::string_view name = term.substr(0, equals);
        const auto setting = std::ranges::find(names, name);
        if (setting == names.end())
            return fail(std::format("unknown setting '{}'; expected {}", name, listed(names)));

        const std::string_view text = term.substr(equals + 1);

        // The one setting that is not a count: how many tiles may be terraformed.
        if (name == "terraform" && text == "unlimited") {
            limits.terraform = Terraforming::Unlimited;
            continue;
        }

        const long long lowerBound = lowerBoundFor(name);
        const std::optional<long long> value = number<long long>(text);
        if (!value || *value < lowerBound)
            return fail(std::format("{} of '{}' must be a whole number of at least {}", name, text, lowerBound));
        if (*value > MaxSetting)
            return fail(std::format("{} of {} exceeds the maximum accepted", name, *value));

        switch (setting - names.begin()) {
        case 0: limits.restarts = static_cast<int>(*value); break;
        case 1: limits.iterations = static_cast<int>(*value); break;
        case 2: limits.improvementPasses = static_cast<int>(*value); break;
        case 3: limits.budget = *value; break;
        case 4: limits.firstRestart = static_cast<int>(*value); break;
        case 5: limits.restartCount = static_cast<int>(*value); break;
        default: limits.terraform = static_cast<int>(*value); break;
        }
    }

    return limits;
}

namespace {

/* The line that ends the search a report describes and begins the layout it
   found. */
constexpr std::string_view FoundMarker = "found";

} // namespace

std::expected<ParsedRepro, Error> repro(std::string_view text)
{
    std::string_view goalSpec;
    std::string_view effortSpec;
    bool goalGiven = false;
    bool effortGiven = false;

    std::string forVillage;
    std::string forFound;
    bool afterMarker = false;

    for (std::size_t at = 0; at <= text.size();) {
        const std::size_t end = std::min(text.find('\n', at), text.size());
        const std::string_view line = text.substr(at, end - at);
        at = end + 1;

        const std::vector<std::string_view> word = Text::words(line);

        // A line whose first word starts with '#' is a note for the reader.
        if (!word.empty() && word.front().front() == '#')
            continue;

        if (!afterMarker && word.size() == 1 && word.front() == FoundMarker) {
            afterMarker = true;
            continue;
        }

        for (const std::string_view token : word) {
            const std::size_t equals = token.find('=');
            const std::string_view name = token.substr(0, equals);

            // The value keeps every '=' after the first, which both specs use.
            if (!afterMarker && equals != std::string_view::npos && (name == "goal" || name == "effort")) {
                const bool isGoal = name == "goal";
                if (isGoal ? goalGiven : effortGiven)
                    return fail(std::format("'{}' is given twice", name));

                (isGoal ? goalSpec : effortSpec) = token.substr(equals + 1);
                (isGoal ? goalGiven : effortGiven) = true;
                continue;
            }

            std::string& into = afterMarker ? forFound : forVillage;
            into += token;
            into += ' ';
        }

        if (end == text.size())
            break;
    }

    if (!goalGiven)
        return fail("no 'goal=' in the report; it names the goals the search ranked by");

    ParsedRepro parsed;

    const std::expected<Goals, Error> goals = Parse::goals(goalSpec);
    if (!goals)
        return std::unexpected{goals.error()};
    parsed.goals = *goals;

    const std::expected<SearchLimits, Error> limits = Parse::effort(effortSpec);
    if (!limits)
        return std::unexpected{limits.error()};
    parsed.limits = *limits;

    const std::expected<ParsedVillage, Error> village = Parse::village(forVillage);
    if (!village)
        return std::unexpected{village.error()};
    parsed.village = *village;

    if (afterMarker) {
        const std::expected<ParsedVillage, Error> layout = Parse::village(forFound);
        if (!layout)
            return fail(std::format("the layout it found: {}", layout.error().message));
        parsed.found = *layout;
    }

    return parsed;
}

namespace {

// The line that ends the village section and begins the steps.
constexpr std::string_view StepsMarker = "steps";

std::optional<std::size_t> tileIndex(std::string_view text)
{
    const std::vector<std::string_view> part = Text::split(text, ',');
    if (part.size() != 2)
        return std::nullopt;

    const std::optional<int> x = number<int>(part[0]);
    const std::optional<int> y = number<int>(part[1]);
    if (!x || !y || !isInside(*x, *y))
        return std::nullopt;

    return Village::index(static_cast<std::size_t>(*x), static_cast<std::size_t>(*y));
}

/* One 'name=value' the simulator owns rather than the village grammar.
   `taken` says whether it was one of those. */
std::optional<Error> takeSetting(ParsedScript& script, std::string_view name, std::string_view text, bool& taken)
{
    taken = true;

    const auto whole = [&](int least, int most, int& into) -> std::optional<Error> {
        const std::optional<int> value = number<int>(text);
        if (!value || *value < least || *value > most)
            return Error{std::format("{} of '{}' must be a whole number from {} to {}", name, text, least, most)};
        into = *value;
        return std::nullopt;
    };

    const auto amount = [&](double most, double& into) -> std::optional<Error> {
        const std::optional<double> value = number<double>(text);
        if (!value || *value < 0.0 || *value > most)
            return Error{std::format("{} of '{}' must be a number from 0 to {:.0f}", name, text, most)};
        into = *value;
        return std::nullopt;
    };

    if (name == "tick")
        return whole(0, static_cast<int>(MaxSetting), script.setup.tick);
    if (name == "until")
        return whole(0, static_cast<int>(MaxSetting), script.until);
    if (name == "tier")
        return whole(1, Simulate::TierCount, script.setup.tier);

    const std::size_t dot = name.find('.');
    const std::string_view group = name.substr(0, dot);
    const std::string_view which = dot == std::string_view::npos ? std::string_view{} : name.substr(dot + 1);

    if (group == "stock") {
        const std::optional<Resource> resource = Resources::tryFromId(which);
        if (!resource)
            return Error{std::format("unknown stock '{}'; expected one of {}", which, listed(Resources::Ids))};
        // A refund can take a store above its capacity, so nothing bounds this.
        return amount(std::numeric_limits<double>::max(), script.setup.stock.resource[*resource]);
    }

    if (group == "charge") {
        const std::optional<Unit> unit = Units::tryFromId(which);
        if (!unit)
            return Error{std::format("unknown charge '{}'; expected one of {}", which, listed(Units::Ids))};
        return amount(Simulate::FullCharge, script.setup.stock.charge[static_cast<std::size_t>(*unit)]);
    }

    if (group == "seals") {
        const std::optional<Seal> seal = Seals::tryFromId(which);
        if (!seal || *seal == Seal::None)
            return Error{std::format("unknown seal '{}'", which)};

        int count = 0;
        if (std::optional<Error> trouble = whole(0, static_cast<int>(Simulate::MaxSeals), count))
            return trouble;
        script.setup.sealsStored[static_cast<std::size_t>(*seal)] = count;
        return std::nullopt;
    }

    taken = false;
    return std::nullopt;
}

// One step line: '<tick> <action> [arguments]'.
std::expected<Simulate::Step, Error> takeStep(std::string_view line, std::size_t atLine)
{
    const std::vector<std::string_view> word = Text::words(line);

    const auto malformed = [&](std::string_view what) {
        return fail(std::format("step on line {} ({}): {}", atLine, line, what));
    };

    if (word.size() < 2)
        return malformed("expected a tick and an action");

    const std::optional<int> tick = number<int>(word[0]);
    if (!tick || *tick < 0)
        return malformed(std::format("'{}' is not a tick", word[0]));

    const std::optional<Simulate::Action> action = Simulate::actionFromName(word[1]);
    if (!action)
        return malformed(std::format("unknown action '{}'", word[1]));

    Simulate::Step step;
    step.tick = *tick;
    step.action = *action;

    const auto arguments = std::span{word}.subspan(2);

    const auto takeOrientation = [&step](std::string_view text) -> std::optional<std::string> {
        const std::optional<Orientation> facing = text.size() == 1 ? Orientations::tryFromChar(text[0]) : std::nullopt;
        if (!facing)
            return std::format("'{}' is not an orientation", text);
        step.orientation = *facing;
        return std::nullopt;
    };

    switch (*action) {
    case Simulate::Action::Build: {
        if (arguments.size() < 2 || arguments.size() > 3)
            return malformed("expected 'build <x>,<y> <building> [orientation]'");

        const std::optional<std::size_t> tile = tileIndex(arguments[0]);
        if (!tile)
            return malformed(std::format("'{}' is not a tile", arguments[0]));
        const std::optional<Building> building = Buildings::tryFromId(arguments[1]);
        if (!building)
            return malformed(std::format("unknown building '{}'", arguments[1]));

        step.tile = *tile;
        step.building = *building;
        if (arguments.size() == 3)
            if (std::optional<std::string> wrong = takeOrientation(arguments[2]))
                return malformed(*wrong);
        break;
    }

    case Simulate::Action::Upgrade:
    case Simulate::Action::Destroy:
    case Simulate::Action::DetachSeal: {
        if (arguments.size() != 1)
            return malformed(std::format("expected '{} <x>,<y>'", Simulate::name(*action)));

        const std::optional<std::size_t> tile = tileIndex(arguments[0]);
        if (!tile)
            return malformed(std::format("'{}' is not a tile", arguments[0]));
        step.tile = *tile;
        break;
    }

    case Simulate::Action::Move: {
        if (arguments.size() < 2 || arguments.size() > 3)
            return malformed("expected 'move <x>,<y> <x>,<y> [orientation]'");

        const std::optional<std::size_t> from = tileIndex(arguments[0]);
        const std::optional<std::size_t> to = tileIndex(arguments[1]);
        if (!from || !to)
            return malformed("expected two tiles, the one moved from and the one moved to");

        step.from = *from;
        step.tile = *to;
        if (arguments.size() == 3)
            if (std::optional<std::string> wrong = takeOrientation(arguments[2]))
                return malformed(*wrong);
        break;
    }

    case Simulate::Action::UpgradeVillage:
        if (!arguments.empty())
            return malformed("'village' takes no arguments");
        break;

    case Simulate::Action::AttachSeal: {
        if (arguments.size() != 2)
            return malformed("expected 'seal <seal> <x>,<y>'");

        const std::optional<Seal> seal = Seals::tryFromId(arguments[0]);
        if (!seal || *seal == Seal::None)
            return malformed(std::format("unknown seal '{}'", arguments[0]));
        const std::optional<std::size_t> tile = tileIndex(arguments[1]);
        if (!tile)
            return malformed(std::format("'{}' is not a tile", arguments[1]));

        step.seal = *seal;
        step.tile = *tile;
        break;
    }

    default:
        return malformed("no such action");
    }

    return step;
}

} // namespace

std::expected<ParsedScript, Error> script(std::string_view text)
{
    ParsedScript parsed;

    std::string village;
    std::vector<std::pair<std::string_view, std::size_t>> steps;
    bool afterMarker = false;

    std::size_t lineNumber = 0;
    for (std::size_t at = 0; at <= text.size();) {
        const std::size_t end = std::min(text.find('\n', at), text.size());
        const std::string_view line = text.substr(at, end - at);
        at = end + 1;
        ++lineNumber;

        const std::vector<std::string_view> word = Text::words(line);

        if (!word.empty() && word.front().front() == '#')
            continue;

        if (!afterMarker && word.size() == 1 && word.front() == StepsMarker) {
            afterMarker = true;
            continue;
        }

        if (!afterMarker) {
            village += line;
            village += '\n';
        } else if (!word.empty()) {
            steps.emplace_back(line, lineNumber);
        }

        if (end == text.size())
            break;
    }

    std::string forVillage;
    bool untilGiven = false;
    for (const std::string_view token : Text::words(village)) {
        const std::size_t equals = token.find('=');
        if (equals != std::string_view::npos) {
            const std::string_view name = token.substr(0, equals);
            if (name == "season")
                return fail("a script prices by the season its tick falls in, so 'season' cannot be set");

            bool taken = false;
            if (std::optional<Error> trouble = takeSetting(parsed, name, token.substr(equals + 1), taken))
                return std::unexpected{*trouble};
            if (taken) {
                untilGiven = untilGiven || name == "until";
                continue;
            }
        }

        forVillage += token;
        forVillage += ' ';
    }

    std::expected<ParsedVillage, Error> start = Parse::village(forVillage);
    if (!start)
        return std::unexpected{start.error()};
    parsed.start = *start;

    std::size_t seals = 0;
    for (std::size_t i = 0; i < Village::Width * Village::Height; ++i)
        seals += parsed.start.village[i].seal != Seal::None ? 1 : 0;
    for (const int held : parsed.setup.sealsStored)
        seals += static_cast<std::size_t>(held);

    if (seals > Simulate::MaxSeals)
        return fail(std::format("{} seals, fitted and stored together, is more than the {} a run tracks", seals, Simulate::MaxSeals));

    for (const auto& [line, atLine] : steps) {
        const std::expected<Simulate::Step, Error> step = takeStep(line, atLine);
        if (!step)
            return std::unexpected{step.error()};
        parsed.steps.push_back(*step);
    }

    if (!untilGiven)
        parsed.until = parsed.steps.empty() ? parsed.setup.tick : parsed.steps.back().tick;

    return parsed;
}

} // namespace Parse

} // namespace Factions
