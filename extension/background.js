// Brings the window of the tab that asked to the very front: restores it if minimised, focuses it, selects the tab.
// If the OS refuses to hand over keyboard focus (Windows foreground lock), drawAttention flashes the taskbar button.
let last = 0;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'bring-to-front' || !sender.tab) return;
  const now = Date.now();
  if (now - last < 800) return;                       // ignore bursts
  last = now;
  raise(sender.tab);
});

async function raise(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    const update = { focused: true, drawAttention: true };
    if (win.state === 'minimized') update.state = 'normal';   // restore (a maximised window stays maximised otherwise)
    await chrome.windows.update(tab.windowId, update);
    await chrome.tabs.update(tab.id, { active: true });         // make sure it is the visible tab of that window
  } catch (e) {
    console.warn('[elvar] bring-to-front failed', e);
  }
}

// Sites added on the options page are registered as persistent content scripts; re-assert after updates.
chrome.runtime.onInstalled.addListener(async () => {
  const { origins = [] } = await chrome.storage.local.get('origins');
  for (const o of origins) await register(o).catch(() => {});
});

async function register(origin) {
  const id = 'elvar-' + origin.replace(/[^a-z0-9]/gi, '_');
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{ id, matches: [origin + '/*'], js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true }]);
}
