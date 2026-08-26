# Render a Marp markdown deck and verify every slide actually fits AND
# actually rendered its content (no content clipped at the bottom edge,
# no local image that silently failed to load). Marp's own build never
# errors or warns on either problem: overflowing content is silently
# cropped, and a local <img>/markdown-image whose file couldn't be read
# (e.g. missing --allow-local-files, wrong relative path) just leaves
# the slide blank, no broken-image icon, no build error. A manual pixel
# check is the only reliable signal for either failure mode.
#
# Usage: marp-check path/to/slides.md [--keep-images]
#
# What it does:
#   1. Installs @marp-team/marp-cli globally if `marp` isn't on PATH yet.
#   2. Renders <slides>.html and <slides>.pdf next to the source file,
#      and the per-slide PNGs below, all with --allow-local-files (decks
#      that embed local diagram images need it on every render pass, not
#      just the PDF one, or those images silently fail to load).
#   3. Renders one PNG per slide (2x scale) into a temp dir.
#   4. Runs a Pillow-based heuristic over every PNG, two checks:
#      a. Overflow: if the band just above the footer (10% of slide
#         height, middle 60% of the width, to skip the footer text on
#         the left and the page number on the right) has more than 1%
#         dark pixels, the slide is flagged as likely overflowing.
#      b. Blank/broken asset: if a slide's ink ratio over its WHOLE
#         canvas is under 0.5%, it's basically just a title with nothing
#         else, flagged so you can confirm that's intentional and not a
#         missing/broken image reference.
#   5. Deletes the temp PNG dir unless --keep-images is passed.
#
# On a flagged slide: open the PNG (or the HTML) to confirm, then fix it:
# overflow by trimming content or splitting into two slides (not by
# shrinking fonts repo-wide); blank/broken by checking the image path is
# correct and relative to the .md file. Re-run marp-check until clean.
marp-check() {
	if [[ -z "$1" || "$1" == "--help" || "$1" == "-h" ]]; then
		echo "Usage: marp-check path/to/slides.md [--keep-images]"
		return 0
	fi

	local src="$1"
	local keep_images=0
	[[ "$2" == "--keep-images" ]] && keep_images=1

	if [[ ! -f "$src" ]]; then
		echo "Error: file not found: $src" >&2
		return 1
	fi

	if ! command -v marp >/dev/null 2>&1; then
		echo "+ marp not found, installing @marp-team/marp-cli globally..." >&2
		npm install -g @marp-team/marp-cli || return 1
	fi

	local dir base html pdf pngdir
	dir="$(dirname "$src")"
	base="$(basename "$src" .md)"
	html="$dir/$base.html"
	pdf="$dir/$base.pdf"
	pngdir="$(mktemp -d "${TMPDIR:-/tmp}/marp-check.XXXXXX")"

	echo "+ marp $src -> $html" >&2
	marp "$src" -o "$html" --allow-local-files || return 1

	echo "+ marp $src -> $pdf" >&2
	marp "$src" --pdf -o "$pdf" --allow-local-files || return 1

	echo "+ rendering per-slide PNGs for overflow check..." >&2
	marp "$src" --images png --image-scale 2 -o "$pngdir/slide.png" --allow-local-files || return 1

	uv run --with pillow python3 - "$pngdir" <<'PYEOF'
import glob
import os
import sys

from PIL import Image

pngdir = sys.argv[1]
files = sorted(glob.glob(os.path.join(pngdir, "slide.*.png")))
suspects = []

def ink_ratio(im, box):
	region = im.crop(box)
	pixels = region.load()
	w, h = region.size
	dark = sum(1 for y in range(h) for x in range(w) if pixels[x, y] < 200)
	total = w * h
	return dark / total if total else 0

blank_suspects = []

for f in files:
	im = Image.open(f).convert("L")
	w, h = im.size

	overflow_ratio = ink_ratio(im, (int(w * 0.30), int(h * 0.90), int(w * 0.90), h))
	overall_ratio = ink_ratio(im, (0, 0, w, h))

	statuses = []
	if overflow_ratio > 0.01:
		statuses.append("OVERFLOW")
		suspects.append(os.path.basename(f))
	if overall_ratio < 0.005:
		statuses.append("BLANK/BROKEN?")
		blank_suspects.append(os.path.basename(f))
	status = ", ".join(statuses) if statuses else "ok"
	print(
		f"{os.path.basename(f)}: overflow_ratio={overflow_ratio:.4f} "
		f"overall_ink={overall_ratio:.4f} {status}"
	)

print("")
failed = False
if suspects:
	print(f"{len(suspects)} slide(s) likely overflow: {', '.join(suspects)}")
	failed = True
if blank_suspects:
	print(
		f"{len(blank_suspects)} slide(s) suspiciously blank "
		f"(check for a missing/broken local image): {', '.join(blank_suspects)}"
	)
	failed = True
if not failed:
	print(f"All {len(files)} slides fit cleanly and rendered content.")
sys.exit(1 if failed else 0)
PYEOF
	local check_status=$?

	if [[ "$keep_images" -eq 1 ]]; then
		echo "+ PNGs kept at: $pngdir" >&2
	else
		rm -rf "$pngdir"
	fi

	return $check_status
}
