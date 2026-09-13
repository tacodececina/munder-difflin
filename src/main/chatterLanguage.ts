/**
 * The LANGUAGE half of the office-personality prompts (officeChat.ts's café
 * dialogue, officeVoice.ts's work-message asides).
 *
 * THE BUG THIS EXISTS TO FIX. Both prompts were written in English and said
 * nothing about what language to ANSWER in, so the model answered in English —
 * always, for everybody, in an app the user had switched to Spanish or Arabic.
 * It mattered doubly at the time, because brewed lines alternated with a canned
 * break-room pool that WAS translated, and the mismatch showed inside a single
 * conversation. Those canned pools are gone (see officeChat.ts), so this module
 * is now the only thing standing between a translated office and a break room
 * that inexplicably speaks English.
 *
 * WHERE THE LANGUAGE COMES FROM. Not from here, and never hardcoded: the UI
 * language the user chose in Settings (i18n, persisted as `language` in the
 * harness config) is threaded down as a locale string. This module's only job is
 * turning that locale into prompt text — it has no opinion about who the user is
 * or where they live beyond the language they asked the app to speak.
 *
 * ENGLISH AND ANYTHING UNRECOGNISED GET NOTHING. `directiveFor` returns an empty
 * string, the prompt is byte-for-byte what it was before this shipped, and the
 * feature is a no-op for every install that has not switched language. That is
 * deliberate: a directive is a change to a prompt that is already tuned, so it
 * is only added where it fixes an actual mismatch.
 *
 * WHY EVERY SHIPPED LOCALE IS COVERED, NOT JUST SPANISH. The app ships four
 * languages (en, es, ar, zh-CN). English is the prompt's own language and needs
 * nothing; the other three all needed a directive, and for a while only Spanish
 * had one. That was survivable while a translated canned pool alternated with
 * the brewed lines — an Arabic or Chinese user still saw *some* dialogue in
 * their language. With the canned pools deleted (officeChat.ts), a missing
 * directive stopped being a cosmetic gap and became the whole break room
 * speaking English at a user who never asked for English. So the rule is now:
 * every locale the picker offers is in this table, and adding a locale to the
 * picker means adding it here in the same change.
 */

/**
 * Fold a locale tag down to its base language subtag: `es-MX`, `es_419`, `ES`
 * all become `es`. Region is dropped on purpose — the app's picker offers one
 * Spanish, and a region-specific entry (should one ever be added) still wants
 * the Spanish directive rather than silently falling through to English.
 */
export function baseLanguage(locale: string | null | undefined): string {
  if (typeof locale !== 'string') return '';
  return locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * Latin-American Spanish, stated as bans and swaps rather than as a label.
 *
 * "Write in Spanish" alone reliably produces PENINSULAR Spanish — `vosotros`,
 * `vale`, `tío`, `ordenador`, `móvil` — which reads as a different country's
 * office to the user this was written for. Naming the forms to avoid and the
 * ones to prefer is what actually moves the output, so the list is concrete.
 *
 * The last line matters as much as the vocabulary: slang that is *reached for*
 * is worse than no slang at all. The register wanted is a real office — casual,
 * dry, unforced — not a costume.
 */
const ES_LATAM = [
  'IDIOMA: escribe TODO en ESPAÑOL LATINOAMERICANO NEUTRO (México / LatAm).',
  'NUNCA español de España: nada de "vosotros", "vale", "tío", "ordenador", "móvil".',
  'Usa "ustedes", "computadora", "celular"; y "ahorita", "chamba" u otros',
  'coloquialismos SOLO cuando caigan solos. Tono de oficina real: coloquial y seco,',
  'nunca forzado ni caricaturesco. No traduzcas ni expliques nada al inglés.'
].join('\n');

/**
 * Modern Standard Arabic, with the register named rather than left to chance.
 *
 * "Write in Arabic" tends to produce either heavy literary فصحى — rhymed,
 * ceremonious, nothing like two colleagues by a coffee machine — or a random
 * regional dialect that reads as the wrong country. Simplified MSA is the one
 * variety every Arabic-speaking user reads as neutral, so it is asked for by
 * name and the alternatives are ruled out.
 *
 * Tool and engineering vocabulary stays in English on purpose: a real Arabic-speaking
 * dev office says "bug", "deploy", "pull request". Translating those is what
 * makes generated office dialogue read as machine translation.
 */
const AR_MSA = [
  'اللغة: اكتب كل شيء بالعربية الفصحى المبسطة. لا تكتب بالإنجليزية.',
  'لا فصحى تراثية ثقيلة ولا سجع ولا خطابة، ولا لهجة محلية بعينها (لا مصرية ولا خليجية ولا شامية).',
  'النبرة نبرة مكتب حقيقي: عفوية، جافة، قصيرة.',
  'اترك المصطلحات التقنية وأسماء الأدوات بالإنجليزية كما هي (bug, deploy, commit, pull request)',
  'ولا تترجمها حرفيًا. لا تضف أي ترجمة إنجليزية ولا تشرح ما كتبته.'
].join('\n');

/**
 * Simplified Chinese, likewise stated as register + bans.
 *
 * The failure mode here is not the wrong country, it is the wrong REGISTER: a
 * bare "write in Chinese" yields 书面语 — report prose, stacked 成语, full
 * sentences nobody says out loud. A break-room line is 口语, short and flat, so
 * that is what the directive asks for and what it forbids the opposite of.
 *
 * Keyed on `zh` because `baseLanguage` folds the region away. The picker ships
 * zh-CN (Simplified) only; if Traditional is ever offered it needs its own entry
 * AND a locale key that survives that fold — the two changes go together.
 */
const ZH_HANS = [
  '语言：全部用简体中文写，不要用英文。',
  '语气是同事在茶水间随口聊天：口语、短句、干脆。不要书面报告腔，不要堆成语，不要煽情。',
  '技术词和工具名保留英文原样（bug、deploy、commit、pull request），不要硬译。',
  '不要附任何英文翻译，也不要解释自己写了什么。'
].join('\n');

/**
 * Prompt directives by base language subtag.
 *
 * Only the languages whose generated dialogue would otherwise be WRONG belong
 * here — which, since the canned pools were deleted, means every locale the app
 * ships except English. Adding one is a single entry, but it is a writing job,
 * not a mechanical one: a bare "answer in <language>" is exactly what produced
 * the Spain-flavoured Spanish, the sermon-Arabic and the report-Chinese that the
 * three entries below exist to correct.
 */
const DIRECTIVES: Readonly<Record<string, string>> = Object.freeze({
  es: ES_LATAM,
  ar: AR_MSA,
  zh: ZH_HANS
});

/**
 * The language directive for a UI locale, or `''` when the prompt should be left
 * exactly as it was (English, an unknown tag, or nothing configured at all).
 *
 * Callers append the result to their own prompt and drop it when empty — see the
 * `.filter(Boolean)` in officeChat.ts's `buildPrompt`.
 */
export function chatterLanguageDirective(locale: string | null | undefined): string {
  return DIRECTIVES[baseLanguage(locale)] ?? '';
}
