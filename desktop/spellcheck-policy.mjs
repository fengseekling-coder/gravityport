/**
 * 审查 3-6 甲（任务 318）:keep Chromium's spellchecker from fetching
 * dictionaries from its CDN.
 *
 * The main window already sets webPreferences.spellcheck: false, which only
 * disables spellchecking for that one webContents — the browser process still
 * initializes the platform spellchecker for the OS languages and, when the
 * system spellchecker lacks a language, may download a Hunspell dictionary
 * from Chromium's servers (an unstated network call).
 *
 * On every platform the spellchecker is switched off for the default session.
 * On non-macOS platforms the dictionary download URL is pointed at a local
 * dead port and the language list is emptied. On macOS
 * setSpellCheckerDictionaryDownloadURL/setSpellCheckerLanguages are documented
 * as not supported, so they are skipped there.
 *
 * Every step is individually guarded: a failure must not break startup. The
 * real "nothing is downloaded" behavior can only be observed on a Windows
 * machine with e.g. German as the system language; this module only pins the
 * wiring (see test/desktop-spellcheck.test.mjs).
 */

const SPELLCHECK_DICTIONARY_DEAD_URL = "http://127.0.0.1:9/";

export function disableSpellcheckDownloads(session, platform, { warn = (line) => console.warn(line) } = {}) {
  const steps = [
    ["setSpellCheckerEnabled", () => session.setSpellCheckerEnabled(false)],
  ];
  if (platform !== "darwin") {
    steps.push(
      ["setSpellCheckerDictionaryDownloadURL", () => session.setSpellCheckerDictionaryDownloadURL(SPELLCHECK_DICTIONARY_DEAD_URL)],
      ["setSpellCheckerLanguages", () => session.setSpellCheckerLanguages([])],
    );
  }
  for (const [name, run] of steps) {
    try {
      run();
    } catch (error) {
      warn(`[MOSA] spellcheck hardening step ${name} failed: ${error?.message || error}`);
    }
  }
}
