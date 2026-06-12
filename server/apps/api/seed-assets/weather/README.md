# Weather icons (Lottie → GIF)

7 animated weather GIFs used by the Weather page (`com.ccp.weather`), one per
theme. The Builder template references them by id; the feeder picks the id via
`wmoToDescTheme` and the gif widget's `src` binding swaps to the matching file.

| theme   | file        | source Lottie (lottiefiles, 256×256 / 60fps / 3s) |
|---------|-------------|---------------------------------------------------|
| clear   | clear.gif   | Sunny                                             |
| partly  | partly.gif  | PartlyCloudyDay                                   |
| cloudy  | cloudy.gif  | Windy                                             |
| rain    | rain.gif    | Rainny_Day                                        |
| thunder | thunder.gif | storm                                             |
| snow    | snow.gif    | Snow                                              |
| fog     | fog.gif     | day_fog                                           |

These same files live in `server/apps/web/public/weather-icons/` (served to the
Builder/simulator). The API copy here is what the publish script ships into the
bundle as `assets/<theme>.gif`.

## Regenerate from Lottie JSON

Raw Lottie JSON downloads are kept out of git (gitignored `/weather/`). To
rebuild a GIF from a Lottie JSON (transparent, 128px, 36 frames):

    NODE_PATH=$(npm root -g) node lottie2gif.cjs input.json /tmp/frames 128 36
    magick -dispose previous -delay 8 -loop 0 /tmp/frames/f*.png \
      -coalesce -layers OptimizeTransparency out.gif

Needs puppeteer (renders lottie-web frames) + ImageMagick. Keep files small
(bundle cap is 16 MB; per-asset cap 4 MB).
