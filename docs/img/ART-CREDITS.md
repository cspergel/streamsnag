# Art credits

The site's product pictures are screenshots of StreamSnag itself (`img/shots/`). This file documents the one other
kind of picture: art generated for StreamSnag with an AI image model (`img/art/`). Every image is decorative
(`alt=""`, `aria-hidden`) and dimmed slightly in dark mode by CSS. Until 2026-11-12 the site's footer named them as illustrations
made with an AI image model; the owner took that clause out of the footer in pass 21, and this file is now where it is said.

## The images on the site

| Image | Page and place | Source draft | Crop (from 1536 x 1024) |
| --- | --- | --- | --- |
| `evening-desk` | Home page, above "Start with tonight's lecture." (lazy) | `desk-high-2.png` | 16:9, rows 100-964 |
| `evening-window` | How it works, under the first heading | `evening-high-1.png` | 16:9, rows 110-974 |
| `guides-flatlay` | Guides index, under the first heading (lazy) | `shelf-high-1.png` | 16:9, rows 80-944 |
| `study-still` | Study tools, under the first heading | `studytools-high-1.png` | 16:9, rows 120-984 |

Each is exported as `-1x.avif`, `-1x.webp` (768 x 432) and `-2x.avif`, `-2x.webp` (1536 x 864) by `make-art.py`
beside the site tooling. The pages show the head images cut to 21:8 (16:9 on a phone) by CSS `object-fit`. Nothing was
painted in or out.

- Model: `gpt-image-2.6-sunburst` (OpenAI Images API, `POST /v1/images/generations`), confirmed in the key's model
  list on 2026-11-11. Requests: `size: 1536x1024`, `output_format: png`, `n: 1`; drafts at `quality: low`, the kept
  images at `quality: high`.
- Cost, from each answer's own usage figures at the documented rates ($5 per 1M text input tokens, $30 per 1M image
  output tokens): about US$0.022 a low draft (664 image tokens) and US$0.043 a high image (1,372 image tokens).
  Pass 8: one draft, US$0.022 (it was the desk on the site until pass 9). Pass 9 (2026-11-12): 12 generations, six
  low drafts and six high images, US$0.392. All so far: 13 generations, US$0.414.
- Checked by eye: no letters or numbers (pages and screens show only blurred grey bars, a plain curve, a play
  triangle), no logo on any laptop, no real product, course or person, no faces.

### Rejected drafts (pass 9)

`evening-low-2` (a chair in the foreground), `shelf-low-1` (kept the arrangement, drawn again at high quality as
`shelf-high-1`), `shelf-low-2`, `studytools-low-2` (a mug added), `evening-low-1` and `studytools-low-1` (drawn again
at high quality), and the two other high desks: `desk-high-1` (laptop too large, tighter than the pass 8 framing) and
`desk-high-3` (laptop cut by the top edge). They are kept in the tooling's `out/` folder and on a contact sheet in the
pass 9 screenshots, and are not on the site.

### Prompts (each sent exactly as one string: the shared prefix, the subject, the rules)

Shared art direction (pass 9: the last sentence, the highlighter yellow, is new):

> Art direction (shared by every image in this set): a quiet editorial still-life photograph for a calm, literate
> study tool, shot like a magazine interior feature. Warm natural light, soft shadows, shallow depth of field, matte
> surfaces, fine paper grain. Palette held to warm off-white paper (#f5f3ee), soft stone and oat neutrals, a deep
> forest green (#0f5a4a) as the main colour, and one small touch of warm orange (#e8590c). Generous empty space, few
> objects, carefully arranged, nothing cluttered or glossy. Calm, grown-up, studious, unhurried. Where it fits
> naturally, one small soft touch of highlighter yellow (#ffe45c), such as a single highlighted line on a printed page
> or the cap of one highlighter pen; never large.

`evening-desk`:

> Subject: an evening study desk seen from slightly above and to the side. A plain unbranded silver laptop, its
> screen showing a soft, out-of-focus pale slide with a simple curve diagram (no characters). Beside it, a few
> printed pages of a neat typeset document laid flat, with a thin column of small forest-green marks in the left
> margin like time stamps, and a slim forest-green pencil resting across them. A plain ceramic mug of black coffee.
> A warm desk lamp out of frame casts a pool of golden light; the rest of the room falls into deep, soft dusk shadow.
> One small orange accent: a single orange paper clip or the orange edge of a notebook. The desk is a pale oak or
> warm linen surface. Wide landscape composition with calm empty space on the left third. Keep the composition of a
> wide evening desk: laptop to the right of centre, the printed pages in the foreground, the mug at the left of the
> laptop, the warm pool of lamp light, and quiet dusk shadow around. On the top printed page one line is softly
> highlighted in yellow.

`evening-window`:

> Subject: a quiet desk by a window at early evening, seen straight on, wide and calm, for the header of a page about
> one evening with one lecture. Outside the window, a soft deep blue-green dusk sky with blurred bare branches. On the
> desk: an unbranded closed silver laptop, a neat squared stack of printed pages with one line softly highlighted in
> yellow on the top sheet, a forest-green cloth-bound notebook with an orange ribbon bookmark, a small round analogue
> desk clock with a plain face and no numerals, its hands at about ten past seven, and a warm lamp switched on making
> a soft golden pool. Generous empty wall above and empty desk at the left, very low clutter. Wide 3:2 landscape.

`guides-flatlay`:

> Subject: flat lay seen from directly above on warm off-white paper ground (#f5f3ee), for the header of a page of
> how-to guides. A loose, orderly arrangement on the right two-thirds: three printed pages fanned slightly, each with
> soft grey lines suggesting paragraphs and a thin forest-green margin of small rounded marks; one line on the top
> page softly highlighted in yellow; a short stack of plain cream index cards held by one small orange clip; a
> forest-green pencil; a folded pair of reading glasses. Clean empty paper on the left third. Soft daylight from the
> top left with long gentle shadows. Wide 3:2 landscape.

`study-still`:

> Subject: a calm study still life on a pale oak table in soft daylight, for the header of a page about study tools.
> Left: a small neat stack of plain cream index cards, the top card slightly turned, one forest-green elastic band
> around the stack. Centre: a single printed page lying flat, soft grey lines suggesting a typeset document with a
> thin forest-green margin of small rounded time marks, and one line on it highlighted in highlighter yellow, a yellow
> highlighter pen with its cap off resting beside it. Right, slightly behind: a plain unbranded open laptop whose
> screen shows an abstract, out-of-focus pale study page (a soft video rectangle above, grey lines of text below, one
> small orange square). Generous empty space above; nothing cluttered. Wide 3:2 landscape.

Rules (the suffix for every image):

> Strict rules: absolutely no text, letters, numbers, words, logos or legible writing anywhere in the image; any
> printed or written page shows only soft grey lines suggesting text, never real characters. No brand marks, no
> logos on any device, no real products, no university crests or real course materials. No people's faces; no
> people at all unless stated. No phones. No speech bubbles, no chat interfaces.

## Not generated

The green band's "What was said / What you read" piece on the home page and the "Pack styles" piece on the study tools
page are HTML and CSS (their words are the samples' and the product's own), not generated images. A concept image of
speech becoming a document was considered in pass 9 and not made: the home page's animation already shows it.

## Terms (checked 2026-11-11)

OpenAI Services Agreement, version "ONLINE v.010126" (effective 1 January 2026), which covers use of the API:
<https://openai.com/policies/services-agreement/> (PDF: <https://cdn.openai.com/osa/openai-services-agreement.pdf>).

- 4.1: "As between Customer and OpenAI, to the extent permitted by applicable law, Customer: (a) retains all
  ownership rights in Input; and (b) owns all Output. OpenAI hereby assigns to Customer all OpenAI's right, title,
  and interest, if any, in and to Output." So the images may be used on a commercial site.
- 4.4: "Output may not be unique, and other users may receive similar content from OpenAI's services." So the art is
  ours to use but not guaranteed exclusive, and (in the United States at least) a purely generated image may not be
  protected by copyright.
- Use must stay within OpenAI's Usage Policies and Sharing and Publication Policy (named in the agreement as the
  "OpenAI Policies"). The site's footer said these scenes were made with an AI image model until pass 21 (2026-11-12), when the owner
  took the clause out; whether the policies ask for a visible note on the site is worth a look before launch.

This is a plain reading for the owner, not legal advice.
