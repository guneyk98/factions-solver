#pragma once

#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "simulate.hpp"
#include "solver.hpp"
#include "village.hpp"

/* Reads the text form of a village, and the two specifications that steer a
   search, into the engine's own types. The text form is the only one the page
   stores: it is what a save, an exported string and an undo step each hold, so
   this grammar has exactly one parser and Json below is its inverse only for
   what the engine computes, never for what it was given. */
namespace Factions {

namespace Parse {

struct Error {
    std::string message;
};

// A village and the conditions to compute it under, as one parse produces them.
struct ParsedVillage {
    Village village;
    GameModifiers modifiers;
    // Which round's rules to compute the village by. 0 means the newest.
    int game = 0;
    // Which season's cost multiplier to use; -1 is the one the game's own
    // multipliers were fetched in. Read only by Cost.
    int season = -1;
};

/* A village the engine can compute: parses, validates, and has every building
   on terrain that can hold it. */
std::expected<ParsedVillage, Error> village(std::string_view text);

/* A weaker condition: a village that parses and validates but may have a
   building on terrain that cannot hold one, which the editor can produce by
   loading a round with a different map or by painting terrain. The page
   displays such a village rather than refusing to open it, and computes
   nothing from it. */
std::expected<ParsedVillage, Error> readableVillage(std::string_view text);

// The goals a search ranks by, and how it ranks them.
struct Goals {
    std::vector<Goal> goals;
    Ranking ranking = Ranking::Lexicographic;
};

/* 'id', 'id:weight' (Ranking::WeightedSum) or 'id=target'
   (Ranking::Ratio), comma separated, each optionally followed by '>=minimum'.
   Weighting or targeting every goal or none of them is what chooses the
   ranking; a minimum is read under any of the three. */
std::expected<Goals, Error> goals(std::string_view spec);

/* 'name=value' settings, comma separated, over SearchLimits' defaults. Every
   one is a whole number, except that 'terraform' also accepts 'unlimited'. */
std::expected<SearchLimits, Error> effort(std::string_view spec);

// A search to repeat: everything rearrange() was given the first time.
struct ParsedRepro {
    ParsedVillage village;
    Goals goals;
    SearchLimits limits;

    /* The layout the search answered with, where the report carries one. The
       search itself is a path through floating-point comparisons, so a build
       other than the one that ran it can settle on another layout of the same
       rank; this one's figures are reproducible whatever ran it. */
    std::optional<ParsedVillage> found;
};

/* The debug report the page writes after a search: the village text with a
   'goal=' token and an optional 'effort=' token among it, and lines whose
   first word starts with '#' dropped as comments. A line reading 'found' ends
   that section, and the village text after it is the layout the search
   answered with.

   The report carries no restart slice, since the page runs the restarts
   across workers and keeps the best: the same restarts run undivided reach
   the same layout, which is what tests/split.py checks. */
std::expected<ParsedRepro, Error> repro(std::string_view text);

// A simulator run: the village it starts from, what the player holds then,
// and the steps taken from there.
struct ParsedScript {
    ParsedVillage start;
    Simulate::Setup setup;
    std::vector<Simulate::Step> steps;
    // The tick the run is wound forward to once every step has been taken.
    int until = 0;
};

/* The text form of a run: the village text, a line reading 'steps', then one
   step per line as '<tick> <action> [arguments]'. The village section also
   carries the simulator's own settings, which the village grammar does not
   know: 'tick', 'until', 'tier', 'stock.<resource>', 'charge.<unit>' and
   'seals.<seal>'. A line whose first word starts with '#' is a comment.

   A script takes its season from the tick it has reached, so 'season' is
   refused rather than ignored. */
std::expected<ParsedScript, Error> script(std::string_view text);

} // namespace Parse

} // namespace Factions
