import { getAllowlist, setAllowlist } from "./lib/allowlist.js";

const serverUrlInput = document.getElementById("serverUrl");
const newDomainInput = document.getElementById("newDomain");
const newLabelInput = document.getElementById("newLabel");
const domainListEl = document.getElementById("domainList");
const statusEl = document.getElementById("status");

let currentEntries = []; // { domain, label }

async function loadSettings() {
  const { serverUrl = "http://127.0.0.1:4317" } = await chrome.storage.local.get(["serverUrl"]);
  serverUrlInput.value = serverUrl;
  currentEntries = await getAllowlist();
  renderEntryList();
}

function renderEntryList() {
  domainListEl.innerHTML = "";
  for (const entry of currentEntries) {
    const li = document.createElement("li");

    const text = document.createElement("span");
    const labelSpan = document.createElement("span");
    labelSpan.className = "entry-label";
    labelSpan.textContent = entry.label;
    text.appendChild(labelSpan);
    if (entry.label !== entry.domain) {
      const domainSpan = document.createElement("span");
      domainSpan.className = "entry-domain";
      domainSpan.textContent = `(${entry.domain})`;
      text.appendChild(domainSpan);
    }

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "remove";
    removeBtn.addEventListener("click", () => {
      currentEntries = currentEntries.filter((e) => e.domain !== entry.domain);
      renderEntryList();
    });

    li.append(text, removeBtn);
    domainListEl.appendChild(li);
  }
}

document.getElementById("addDomain").addEventListener("click", () => {
  const domain = newDomainInput.value.trim().toLowerCase();
  const label = newLabelInput.value.trim() || domain;
  if (domain && !currentEntries.some((e) => e.domain === domain)) {
    currentEntries.push({ domain, label });
    renderEntryList();
  }
  newDomainInput.value = "";
  newLabelInput.value = "";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: serverUrlInput.value.trim() });
  await setAllowlist(currentEntries);
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

loadSettings();
