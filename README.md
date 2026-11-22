# Fast makefun-site drop-in

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own `makefun-site` 1.0.0, built for the
[make.fun bounty site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
— "Build a static site faster, 22 November 2026".

`solve.js` is an original, dependency-free ES module whose `run(input)`
returns exactly the answer `makefun-site` 1.0.0 returns for every case:
the output tree of the case's site — every page's `index.html`, the index
and tag pages, `build-report.txt` and each static file — byte for byte.
`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

- **Templates:** each template is parsed once into a flat program of
  parallel arrays (jumps instead of a nested node tree), and rendered by
  one loop with an explicit control stack — no recursive walk per node and
  per loop iteration, and each `for` reuses one scope object and one
  `loop` object per element instead of allocating them.
- **Markdown:** a single pass over the lines (no token array) with a
  first-character dispatch, and inline rendering driven by one native
  regex scan that jumps between interesting characters — structural
  (`\`, `` ` ``, `*`, `[`) and HTML specials (`& < > " '`) alike — so a
  literal run is already entity-clean when flushed, with no separate
  escape pass and no per-character escaping. Strong/emphasis/link bodies
  recurse over string ranges, so no substring is taken for them.
- **Text:** slugs and long dates cached per case (ASCII titles skip NFKD
  normalisation), unique slugs via a per-base counter instead of
  rescanning from `-2`, word counts by a manual scan with a whitespace
  table instead of a regex match array, front matter walked with
  `indexOf` instead of split-and-rejoin.
- No dynamic code compilation, no `vm` module, no WebAssembly, no native addon,
  nothing installed before the program runs: plain JavaScript only, and
  nothing cached from one case to the next.

## Practice results

On the kit's practice set (3 cases, 257–486 files each), byte-identical
to `makefun-site` 1.0.0 on every case — verified against
`practice/reference/expected.json`, and on 36 further cases drawn fresh
from the competition generator (12 random seeds):

| | `run()` on the practice set |
|---|---|
| makefun-site 1.0.0 (house baseline) | ~460–515 ms |
| this entry | ~135 ms |

About **3.5× faster** than the house baseline on the practice set
(~4.2× on one fresh draw: 640 ms vs 154 ms).

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node --experimental-strip-types main.ts
```

Node 22 runs `node /bot/main.ts` in the harness; `main.ts` turns V8's
incremental marking off before importing `solve.js`, as the house
baseline does.
