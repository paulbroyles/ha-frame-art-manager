## Future Investigations

### Virtual TV for test-fetch orientation preview
The test-fetch UI currently accepts a `tvOrientation` to simulate fetching for a
specific TV orientation (used with the `match_tv` filter). However, users without a
portrait-mounted physical TV cannot easily test portrait-mode artwork selection.

Investigate adding a "virtual TV" concept: a named configuration entry with no
physical IP, used purely for test-fetch with a fixed orientation. This would let
users preview how the orientation filter behaves in portrait mode without owning
portrait-mounted hardware.

See the `POST /api/web-sources/test-fetch` route in `routes/web_sources.js` and
the `tvOrientation` parameter.