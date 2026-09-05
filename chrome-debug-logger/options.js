import { getAllowlist, setAllowlist } from "./lib/allowlist.js";

const serverUrlInput = document.getElementById("serverUrl");
const newDomainInput = document.getElementById("newDomain");
const domainListEl = document.getElementById("domainList");
const statusEl = document.getElementById("status");

let currentDomains = [];

async function loadSettings() {
  const { serverUrl = "http://127.0.0.1:4317" } = await chrome.storage.local.get(["serverUrl"]);
  serverUrlInput.value = serverUrl;
  currentDomains = await getAllowlist();
  renderDomainList();
}

function renderDomainList() {
  domainListEl.innerHTML = "";
  for (const domain of currentDomains) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "remove";
    removeBtn.addEventListener("click", () => {
      currentDomains = currentDomains.filter((d) => d !== domain);
      renderDomainList();
    });
    li.append(label, removeBtn);
    domainListEl.appendChild(li);
  }
}

document.getElementById("addDomain").addEventListener("click", () => {
  const value = newDomainInput.value.trim().toLowerCase();
  if (value && !currentDomains.includes(value)) {
    currentDomains.push(value);
    renderDomainList();
  }
  newDomainInput.value = "";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: serverUrlInput.value.trim() });
  await setAllowlist(currentDomains);
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

loadSettings();
