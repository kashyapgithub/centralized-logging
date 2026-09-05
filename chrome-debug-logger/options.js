import { getAllowlist, setAllowlist } from "./lib/allowlist.js";

const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseAnonKeyInput = document.getElementById("supabaseAnonKey");
const newDomainInput = document.getElementById("newDomain");
const domainListEl = document.getElementById("domainList");
const statusEl = document.getElementById("status");

let currentDomains = [];

async function loadSettings() {
  const { supabaseUrl = "", supabaseAnonKey = "" } = await chrome.storage.local.get([
    "supabaseUrl",
    "supabaseAnonKey",
  ]);
  supabaseUrlInput.value = supabaseUrl;
  supabaseAnonKeyInput.value = supabaseAnonKey;
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
  await chrome.storage.local.set({
    supabaseUrl: supabaseUrlInput.value.trim(),
    supabaseAnonKey: supabaseAnonKeyInput.value.trim(),
  });
  await setAllowlist(currentDomains);
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

loadSettings();
