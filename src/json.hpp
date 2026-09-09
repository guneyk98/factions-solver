#pragma once

#include <span>
#include <string>

#include "effects.hpp"
#include "solver.hpp"
#include "village.hpp"

/* Writes what the engine computed as the JSON the page reads. Nothing here
   parses: Parse holds the only reader of the village text, and a village is
   written back through of(const Village&) so the page never implements the
   grammar a second time. */
namespace Factions {

namespace Json {

/* Takes the village and the game as well as the computed output, because the
   reply carries build costs, which are derived from the village itself rather
   than from anything runEffects returns. */
std::string of(const Output& output, const ProductionDetail& detail, const AuraDetail& auras, const Game::Config& game, const Village& village, int season = -1);

// A search result: what each goal reached, and the layout that reached it.
std::string of(const SearchResult& found, std::span<const Goal> goals, Ranking ranking);

/* A village in the form the page holds one, which is what parsing its text
   produces. Returning it keeps the grammar in one parser, so the page writes
   the text and receives tiles back rather than reading it itself. */
std::string of(const Village& village);

} // namespace Json

} // namespace Factions
