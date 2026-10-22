# Image assets

## Bundled animal photographs

The six JPEGs directly in this directory are the bundled inputs for `npm run demo:images` and the image-seeding API.
They are published under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) by their photographers through the
[WordPress Photo Directory](https://wordpress.org/photos/license/).

| File            | Photographer       | Source photo                                                 |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `butterfly.jpg` | ChrisEdwardsCE     | [58462d2edb](https://wordpress.org/photos/photo/58462d2edb/) |
| `cat.jpg`       | Kanta              | [168636e05f](https://wordpress.org/photos/photo/168636e05f/) |
| `dog.jpg`       | Swetha B Chandran  | [7786acc885](https://wordpress.org/photos/photo/7786acc885/) |
| `elephant.jpg`  | mriduljp           | [526acb0605](https://wordpress.org/photos/photo/526acb0605/) |
| `penguin.jpg`   | Randall Montenegro | [85569dad85](https://wordpress.org/photos/photo/85569dad85/) |
| `rabbit.jpg`    | Anup Neupane       | [5716a14700](https://wordpress.org/photos/photo/5716a14700/) |

[sources.json](sources.json) records the source pages, photographer profiles, direct download URLs, verification dates
and SHA-256 checksums. These files are the source-provided small JPEGs, renamed without further image changes.
`../rabbit.jpg` is an identical copy retained for tests and the server fallback. CC0 does not require attribution; the
records preserve credit and make each bundled file identifiable.

The standalone image example reads these local photographs without downloading additional images. Its `rebuild`
command resets the demo database and preserves the image files.

## Local webclient demo inputs

The webclient demo and `npm run seed:test` read image inputs from these folders:

```text
photos/   450 Flickr8k images, captions.json and Flickr8k-NOTICE.txt
gallery/  150 different Flickr8k images without caption metadata
memes/    240 meme images
```

`photos/captions.json` maps each image filename to its five Flickr8k descriptions. Gallery images are imported without
descriptions so they can be searched using image embeddings alone. Meme titles come from filenames. Different templates
with the same original filename have a short content-checksum suffix.

The seeder stores the image bytes in the database. Source files remain available for generating another database. The
Flickr8k notice records dataset attribution; individual photo and meme redistribution rights are not fully documented.
See the [webclient guide](../../../src/webclient/README.md) for source discovery and [licences.md](../../../licences.md)
for the available attribution.

These local datasets are ignored by Git and are separate from the bundled animal photographs.
