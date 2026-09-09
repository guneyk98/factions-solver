#include "parse.hpp"

#include "game.hpp"
#include "effects.hpp"
#include "text.hpp"

#include <algorithm>
#include <array>
#include <charconv>
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

    for (std::size_t i = 0; i < TileCount; ++i) {
        const std::expected<Tile, Error> tile = takeTile(layout[i + 1], i);
        if (!tile)
            return std::unexpected{tile.error()};
        village[i] = *tile;
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

    // 'id' or 'id:weight', separated by commas.
    for (const std::string_view term : Text::split(spec, ',')) {
        const std::size_t colon = term.find(':');
        const std::string_view id = term.substr(0, colon);
        double weight = 1.0;

        if (colon != std::string_view::npos) {
            const std::string_view text = term.substr(colon + 1);
            const std::optional<double> given = number<double>(text);
            if (!given || *given < 0)
                return fail(std::format("goal '{}' has a weight of '{}', which must be a number of at least 0", id, text));
            weight = *given;
            ++weighted;
        }

        const Objective::Info* const info = Objective::find(id);
        if (info == nullptr)
            return fail(std::format("unknown goal '{}'; expected one or more of {}", id, listed(Objective::all() | std::views::transform(&Objective::Info::id))));
        if (std::ranges::any_of(goals.goals, [info](const Goal& goal) { return goal.objective == info; }))
            return fail(std::format("goal '{}' is named twice", id));

        goals.goals.push_back(Goal{info, weight});
    }

    if (weighted != 0 && weighted != goals.goals.size())
        return fail("either every goal carries a weight or none does");

    goals.ranking = weighted == 0 ? Ranking::Lexicographic : Ranking::WeightedSum;
    return goals;
}

std::expected<SearchLimits, Error> effort(std::string_view spec)
{
    SearchLimits limits;

    // Every setting is a non-negative integer parsed the same way; only the
    // field it lands in differs. A budget counts arrangements, so it alone
    // needs the wider type.
    constexpr std::array<std::string_view, 6> names{"restarts", "iterations", "improvementPasses", "budget", "first", "count"};

    // A slice of the restarts may legitimately start at 0 or be empty.
    const auto lowerBoundFor = [](std::string_view name) { return name == "first" || name == "count" ? 0 : 1; };

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
        default: limits.restartCount = static_cast<int>(*value); break;
        }
    }

    return limits;
}

} // namespace Parse

} // namespace Factions
