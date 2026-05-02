// src/whatsapp/messages.js

// Point 2: always show original CMS deadline string in msg (e.g. "11 March 8pm")
// Point 1: extension msgs include "Extended" context

function alert48hrBatch(items) {
  if (items.length === 1) {
    const { courseName, title, deadlineDisplay, isSudden, isExtension } = items[0];
    const tag = isExtension ? ' *(Extended)*' : '';
    if (isSudden)
      return `🆕 *New Assignment — Short Deadline!*${tag}\n\n📚 *Course:* ${courseName}\n📝 *Assignment:* ${title}\n⏰ *Deadline:* ${deadlineDisplay}\n\n⚠️ Uploaded with less than 24hrs remaining — act immediately!`;
    return `⚠️ *Assignment Reminder — 48 Hours Left*${tag}\n\n📚 *Course:* ${courseName}\n📝 *Assignment:* ${title}\n⏰ *Deadline:* ${deadlineDisplay}\n\nSubmit before the deadline! 🚀`;
  }

  const lines = items.map(({ courseName, title, deadlineDisplay, isSudden, isExtension }, i) => {
    const tag = isExtension ? ' *(Extended)*' : '';
    return `${i + 1}. ${isSudden ? '🆕' : '📝'} *${title}*${tag}\n   📚 ${courseName}\n   ⏰ ${deadlineDisplay}`;
  }).join('\n\n');

  return `⚠️ *Assignment Reminders — ${items.length} Deadlines Within 48 Hours*\n\n${lines}\n\nSubmit all before the deadlines! 🚀`;
}

function alert6hrBatch(items) {
  if (items.length === 1) {
    const { courseName, title, deadlineDisplay, isExtension } = items[0];
    const tag = isExtension ? ' *(Extended)*' : '';
    return `🚨 *URGENT — Assignment Due Soon!*${tag}\n\n📚 *Course:* ${courseName}\n📝 *Assignment:* ${title}\n⏰ *Deadline:* ${deadlineDisplay}\n\n⚡ Less than *6 hours* left! Submit *NOW* 🔥`;
  }

  const lines = items.map(({ courseName, title, deadlineDisplay, isExtension }, i) => {
    const tag = isExtension ? ' *(Extended)*' : '';
    return `${i + 1}. 📝 *${title}*${tag}\n   📚 ${courseName}\n   ⏰ ${deadlineDisplay}`;
  }).join('\n\n');

  return `🚨 *URGENT — ${items.length} Assignments Due Within 6 Hours!*\n\n${lines}\n\n⚡ Submit all *NOW* before it's too late! 🔥`;
}

function alertExtended({ courseName, title, deadlineDisplay }) {
  return `📅 *Assignment Deadline Extended*\n\n📚 *Course:* ${courseName}\n📝 *Assignment:* ${title}\n🆕 *New Deadline:* ${deadlineDisplay}\n\n48hr and 6hr reminders will fire again for this assignment.`;
}

module.exports = { alert48hrBatch, alert6hrBatch, alertExtended };