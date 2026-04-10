# Paris Musées

Paris Musées is the network of fourteen Paris municipal museums. Their collection portal is at
https://www.parismuseescollections.paris.fr/. This source is a **thin wrapper** over the
[Wikimedia Commons](WIKIMEDIA_COMMONS.md) source, pre-scoped to `Category:Images from Paris Musées`.

See [WIKIMEDIA_COMMONS.md](WIKIMEDIA_COMMONS.md) for full API details, fetch strategy, and
filter documentation. All Wikimedia Commons filters except **Institution** are available here
(institution is pre-set to Paris Musées and hidden from the UI).

---

## Collection

~326,000 CC0 files from Paris's fourteen municipal museums, including:

- Petit Palais
- Musée Carnavalet
- Musée d'Art Moderne de Paris
- Musée Bourdelle
- Musée Cernuschi
- Musée Cognacq-Jay
- Musée de la Chasse et de la Nature
- Musée de la Vie Romantique
- Palais Galliera
- Maison de Victor Hugo
- Musée Zadkine

---

## Available Filters

| Filter | Type | Notes |
|---|---|---|
| Media Type | require / exclude | Paintings, Drawings, Prints, etc. |
| Subject | require | Portraits, Landscapes, Still lifes, etc. |
| Century | require | 13th–21st century; combined with Media Type for precision |
| License | require / exclude | CC0, CC BY, Public Domain, etc. |
| Artist | require (text) | Searched within the Paris Musées category |
| Search | require (text) | Keyword search within the Paris Musées category |

---

## artworkUrl

Points to the Wikimedia Commons file page (`https://commons.wikimedia.org/wiki/File:...`).
There is no programmatic link back to `parismuseescollections.paris.fr` without their API.

---

## Implementation

`sources/paris_musees.js` injects `{ type: 'institution', mode: 'require', values: ['Paris Musées'] }`
into all calls to the underlying commons module and overrides `sourceLabel = 'Paris Musées'`.
No API key is required.
