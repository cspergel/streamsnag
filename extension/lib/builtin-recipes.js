// Rules that ship with StreamSnag, for course sites where it was tested and where finding the video (or
// naming the lecture) the ordinary way was proven not to work. Data only, in the same format as a rule of
// your own (lib/recipes.js), and kept apart from yours: a built-in rule is never stored with your rules,
// cannot be edited into something else, and gives way to a rule of your own for the same site.
//
// A rule belongs here only with evidence: a real public page where this build's own detection fails or
// names the lecture wrongly, and where the rule puts it right. A site that is already found correctly gets
// no rule. A built-in rule may not ask a site for anything (no "fetch" rule): it only reads the page that
// is open.
//
// Checked on the live sites on 2026-11-11: MIT OpenCourseWare lecture pages, Open Yale Courses, NPTEL,
// Stanford Engineering Everywhere, media.ccc.de and FOSDEM were all found and named correctly by ordinary
// detection, so none of them has a rule here. Each rule below says which pages it was proven on.
import { normalizeRecipe, hasFetchRule } from './recipes.js';

const RAW = [
  // videolectures.net (checked 2026-11-11 on /videos/NAIXUSResearchSeminars_godoy_oliveira and
  // /videos/NAIXUSResearchSeminars_srakar_casual). The video itself is found the ordinary way. Its name was
  // not: the heading nearest the player is the speaker's name ("Cristina Godoy de Oliveira"), and that is
  // what the lecture was called. The lecture's own name is the page's main heading.
  {
    site: 'videolectures.net',
    description: 'On a lecture\'s page the heading by the player is the speaker\'s name. The lecture is called what the page\'s main heading says.',
    rules: [],
    title: [{ type: 'selector', selector: 'h1.title', attr: 'text' }],
  },
  // (carmin.tv had a rule here for one day: its embedded player gives its own site's name, "Carmin PeerTube",
  // as the video's. That was a fault of ordinary detection, which now never takes a site's own name for a
  // video's (lib/naming.js: siteOnly), so the two pages it was proven on are named right without a rule.)
];

/** Check one shipped rule: the format every rule has, and nothing that makes a request. */
export function checkBuiltin(raw) {
  const r = normalizeRecipe(raw);
  if (hasFetchRule(r)) throw new Error(`Built-in rule for ${r.site}: a built-in rule may not ask the site for anything`);
  return r;
}

const freeze = (x) => {
  if (x && typeof x === 'object') {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};

/** The shipped rules, each checked as it is loaded and frozen: [{ site, description, rules, title?, captions? }]. */
export const BUILTIN_RECIPES = freeze(RAW.map(checkBuiltin));
