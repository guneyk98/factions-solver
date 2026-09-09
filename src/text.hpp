#pragma once

#include <cstddef>
#include <string_view>
#include <vector>

namespace Factions {

namespace Text {

/* Splits text at every delimiter. Two delimiters in a row leave an empty field
   between them, which is what lets a caller tell 'a::b' from 'a:b'. */
inline std::vector<std::string_view> split(std::string_view text, char delimiter)
{
    std::vector<std::string_view> pieces;
    for (std::size_t pos = 0;;) {
        const std::size_t at = text.find(delimiter, pos);
        pieces.push_back(text.substr(pos, at - pos));
        if (at == std::string_view::npos)
            return pieces;
        pos = at + 1;
    }
}

// The same, splitting on runs of whitespace and dropping empty fields, so
// village text may span any number of lines.
inline std::vector<std::string_view> words(std::string_view text)
{
    constexpr std::string_view whitespace = " \t\r\n";

    std::vector<std::string_view> found;
    for (std::size_t pos = 0; pos < text.size();) {
        const std::size_t begin = text.find_first_not_of(whitespace, pos);
        if (begin == std::string_view::npos)
            break;
        const std::size_t end = text.find_first_of(whitespace, begin);
        found.push_back(text.substr(begin, end - begin));
        pos = (end == std::string_view::npos) ? text.size() : end;
    }
    return found;
}

} // namespace Text

} // namespace Factions
