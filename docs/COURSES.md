# 履修登録サポート (course-registration support)

Modelled on the シフト module (`server/shift.js`). Each user's records live in that user's own second brain (their notes in the account, visible to them alone; they appear in "My data" and in the export). Nothing is shared between users. Every number (credits, conflicts, CAP, checks, suggestions) is computed by plain code, never by the model.

**What it cannot do (and says so):** the app cannot see the university's registration site, the syllabus or the real course catalogue, and it registers nothing anywhere. The data is only what the user tells ELVAR or types into the screen. Rules of the university (graduation requirements, CAP) are whatever the user entered. The persona and the screen both say this. Syllabus URL / PDF reading is deliberately not built.

## Data (the user's own notes, Markdown, in the account's second brain)
| File | Content |
|---|---|
| `履修/設定.md` | period times (`- 1限：09:00-10:30` … default 1限 9:00–10:30, 2限 10:40–12:10, 3限 13:00–14:30, 4限 14:40–16:10, 5限 16:20–17:50, 6限 18:00–19:30, 7限 19:40–21:10) and the teaching period of each term (`- 後期の授業期間：10-01〜01-31`; default 前期 04-01〜07-31, 後期 10-01〜01-31) |
| `履修/卒業要件.md` | `- 卒業単位：124`, `- 学期の履修上限：24` (CAP; `- 学期の履修上限 2026-後期：20` for one term), `- 区分 必修：30` …, `- 必修科目：線形代数、微分積分` |
| `履修/YYYY-前期｜後期.md` | the courses of a term (YYYY = 年度) as a table: id, 科目, 時間割, 単位, 区分, 状態, 必修, 教員, 教室, 成績, 備考 |

時間割 cell: `月3`, `火2-3` (consecutive), `月1・3`, `月3/木3` (twice a week), `集中`, `オンデマンド` (no slot, never conflicts). 状態: 候補 / 履修 / 抽選待ち / 取消 / 修得済み (nothing is called 履修 unless the user says so; the default is 候補).
Slot words are parsed by `parseSlots` / `parseSlot`: 「月曜3限」「火2・3」「木曜日の3-4限」「金曜の3限と4限」「月3/木3」. 「水曜の午後」 is understood as a time window, but a course needs a concrete period, so it is asked back.

## Logic (`server/course.js`, pure and tested)
- `findConflicts`: same day, overlapping periods. Levels: `registered` (履修×履修, red), `candidate` (履修×候補/抽選待ち), `alternative` (候補同士: choose one). 取消・修得済み are ignored.
- `creditTotals`: term 履修 / 候補 / 抽選待ち credits, CAP left / over; graduation total and per category (修得済み of all terms + 履修), remaining credits.
- `checkTerm` → observations ordered bad > warn > info: conflicts, CAP over, 抽選待ち that would exceed CAP, missing 必修科目 (not recorded / only 候補 / 取消), categories still short, days with 5+ classes or 4+ in a row, 1限 days, free days, gaps (空きコマ), 抽選待ち.
- `suggestCourses` (deterministic greedy, explained): only 候補 courses; required first (flag or listed 必修科目), then days already on campus (fewest days), then the biggest category shortage; never overlaps a registered/chosen course, never exceeds the CAP, honours `avoid1限`, `freeDays`, `maxPerDay` (a required course overrides a wish and carries a note). The result lists proposals with reasons, skipped courses with reasons, what is still short and plain notes (e.g. "候補だけでは足りません"). Nothing is changed until the owner agrees.

## Tools (`server/google/tools.js`, enabled when the second brain is configured)
`course_add` (one or `courses[]`, own records: no approval card), `course_update` (`id` or `ids[]`; status changes incl. adopting a suggestion), `course_cancel` (deletes the record; by voice an approval card, `confirmed:true` only from the screen's ✕ after its own confirm dialog; "dropped / lost the lottery" is `course_update` status=取消), `course_requirements` (卒業単位, CAP, categories, 必修科目, period times, teaching period, `clear`), `course_summary` (read; timetable + totals + checks; the screen opens), `course_suggest` (read; the proposals appear in the screen's suggestion card), `course_view` (opens the screen). Client handling is in `web/src/google-tools.js` (`COURSE_WRITES` re-open the screen on the term just changed).

## Screen (`web/src/course-view.js`)
Same `.vf-*` look as 家計 / シフト. Term switcher ◀ ▶ (前期/後期), weekly timetable 月–土 × 1–7限 with times (cells coloured by category; 候補/抽選待ち dashed orange; overlaps red; 集中・オンデマンド listed under the grid), KPIs, credit meters (graduation total, this term vs CAP, each category: 修得済み / 履修 / 抽選待ち), the course list (status select, ✎ edit, ✕ delete), 注意, the suggestion card (1限なし / 空ける曜日 / 1日のコマ数 → ✦ 作る → checkbox list → 履修にする), and a manual form (科目 / 卒業要件・上限 / 時限の時刻). It fits 1024×600 without scrolling the page and stacks on a phone.
Navigation (the nav bar has no free slot, so no icon): a 「履修」 button in the シフト header and a 「シフト」 button in the 履修 header; otherwise voice / typed (`course_view`, `course_summary`). The HUD home button closes it.

## Link with シフト (optional; no 履修 data → nothing changes)
`classOccurrences` turns every 履修 course of the term in force on a date into a weekly block (consecutive periods merged, period times from 設定, only within the teaching period, so summer / spring breaks are free). `classEvents(month)` is used by
- `shift_suggest`: the classes are added to the busy list (the existing ±30 min margin applies); the result carries `classesUsed`.
- `shift_summary`: the class blocks are merged (titled 「授業：科目」) into the events passed to `classifyDays`, so a class day with no free 3 h block becomes 'busy' and other class days 'check' through the unchanged classification; without Google Calendar the classes alone still colour the calendar.
Not known: holidays, 休講, makeup days, 集中講義 dates.

## Not verified here
A real Supabase project with these notes, real Google Calendar, real voice use, and any real university's rules (period times, CAP, requirement categories are the user's input).
