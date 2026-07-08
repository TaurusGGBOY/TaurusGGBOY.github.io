import {
  QUEUE_STORAGE_KEY,
  addQueuedSlug,
  deserializeQueuedSlugs,
  serializeQueuedSlugs,
} from "../lib/queue";

const INTERACTIONS_INITIALIZED_KEY = "homeInteractionsInitialized";

interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface QueueStore {
  read(): string[];
  write(slugs: string[]): void;
}

interface DialogOpeners {
  contact: HTMLElement | null;
  preview: HTMLElement | null;
  search: HTMLElement | null;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePostTags(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

export function createQueueStore(storage: QueueStorage | null | undefined): QueueStore {
  let memoryQueue: string[] = [];
  let useMemoryQueue = false;

  return {
    read() {
      if (useMemoryQueue || !storage) {
        return memoryQueue;
      }

      try {
        return deserializeQueuedSlugs(storage.getItem(QUEUE_STORAGE_KEY));
      } catch {
        useMemoryQueue = true;
        return memoryQueue;
      }
    },
    write(slugs) {
      const serializedSlugs = serializeQueuedSlugs(slugs);
      memoryQueue = deserializeQueuedSlugs(serializedSlugs);

      if (useMemoryQueue || !storage) {
        return;
      }

      try {
        storage.setItem(QUEUE_STORAGE_KEY, serializedSlugs);
      } catch {
        useMemoryQueue = true;
      }
    },
  };
}

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function updateQueueCounts(count: number): void {
  document.querySelectorAll<HTMLElement>("[data-queue-count]").forEach((counter) => {
    counter.textContent = String(count);
  });
}

function isFocusableElement(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && typeof element.focus === "function";
}

function getActiveElement(): HTMLElement | null {
  return isFocusableElement(document.activeElement) ? document.activeElement : null;
}

function focusDialogElement(dialog: HTMLElement, preferredElement?: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    const focusTarget =
      preferredElement ??
      dialog.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ) ??
      dialog;

    if (!dialog.hasAttribute("tabindex")) {
      dialog.setAttribute("tabindex", "-1");
    }

    focusTarget.focus();
  });
}

function restoreFocus(opener: HTMLElement | null, closedDialog: HTMLElement): void {
  if (opener?.isConnected) {
    opener.focus();
    return;
  }

  const activeElement = getActiveElement();
  if (activeElement && closedDialog.contains(activeElement)) {
    activeElement.blur();
  }
}

function closeSearchOverlay(searchOverlay: HTMLElement | null, opener: HTMLElement | null): void {
  if (!searchOverlay || searchOverlay.hidden) {
    return;
  }

  searchOverlay.hidden = true;
  restoreFocus(opener, searchOverlay);
}

function closePreviewDrawer(previewDrawer: HTMLElement | null, opener: HTMLElement | null): void {
  if (!previewDrawer || previewDrawer.hidden) {
    return;
  }

  previewDrawer.hidden = true;
  restoreFocus(opener, previewDrawer);
}

function closeContactModal(contactModal: HTMLElement | null, opener: HTMLElement | null): void {
  if (!contactModal || contactModal.hidden) {
    return;
  }

  contactModal.hidden = true;
  restoreFocus(opener, contactModal);
}

function initializeSearch(openers: DialogOpeners): void {
  const searchOverlay = document.querySelector<HTMLElement>("[data-search-overlay]");
  const searchInput = document.querySelector<HTMLInputElement>("[data-search-input]");
  const searchResults = Array.from(document.querySelectorAll<HTMLElement>("[data-search-result]"));
  const searchForm = searchInput?.closest("form");

  document.querySelectorAll<HTMLButtonElement>("[data-search-open]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!searchOverlay) {
        return;
      }

      openers.search = getActiveElement();
      searchOverlay.hidden = false;
      focusDialogElement(searchOverlay, searchInput);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-search-close]").forEach((button) => {
    button.addEventListener("click", () => closeSearchOverlay(searchOverlay, openers.search));
  });

  searchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  searchInput?.addEventListener("input", () => {
    const query = normalizeSearchText(searchInput.value);

    searchResults.forEach((result) => {
      const searchText = normalizeSearchText(result.dataset.searchText ?? "");
      result.hidden = query.length > 0 && !searchText.includes(query);
    });
  });
}

function initializeTopics(): void {
  const topicButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-topic]"));
  const topicReset = document.querySelector<HTMLButtonElement>("[data-topic-reset]");
  const postCards = Array.from(document.querySelectorAll<HTMLElement>("[data-post-card]"));

  const setActiveTopic = (topic: string | null) => {
    const normalizedTopic = topic ? normalizeSearchText(topic) : null;

    postCards.forEach((card) => {
      const tags = parsePostTags(card.dataset.tags ?? null).map(normalizeSearchText);
      card.hidden = normalizedTopic === null ? false : !tags.includes(normalizedTopic);
    });

    topicButtons.forEach((button) => {
      const isActive = Boolean(normalizedTopic) && normalizeSearchText(button.dataset.topic ?? "") === normalizedTopic;
      button.setAttribute("aria-pressed", String(isActive));
    });
    topicReset?.setAttribute("aria-pressed", String(normalizedTopic === null));
  };

  topicButtons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => setActiveTopic(button.dataset.topic ?? null));
  });

  topicReset?.setAttribute("aria-pressed", "true");
  topicReset?.addEventListener("click", () => setActiveTopic(null));
}

function initializeQueue(queueStore: QueueStore): void {
  updateQueueCounts(queueStore.read().length);

  document.querySelectorAll<HTMLButtonElement>("[data-queue-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.queueAdd;
      if (!slug) {
        return;
      }

      const queuedSlugs = addQueuedSlug(queueStore.read(), slug);
      queueStore.write(queuedSlugs);
      updateQueueCounts(queuedSlugs.length);
    });
  });
}

function initializePreview(openers: DialogOpeners): void {
  const previewDrawer = document.querySelector<HTMLElement>("[data-preview-drawer]");
  const previewPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-preview-panel]"));

  document.querySelectorAll<HTMLButtonElement>("[data-preview-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.previewOpen;
      if (!previewDrawer || !slug) {
        return;
      }

      openers.preview = getActiveElement();
      previewPanels.forEach((panel) => {
        panel.hidden = panel.dataset.previewPanel !== slug;
      });
      previewDrawer.hidden = false;
      const activePanel = previewPanels.find((panel) => panel.dataset.previewPanel === slug);
      focusDialogElement(previewDrawer, activePanel?.querySelector<HTMLElement>("a, button") ?? null);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-preview-close]").forEach((button) => {
    button.addEventListener("click", () => closePreviewDrawer(previewDrawer, openers.preview));
  });
}

function initializeContact(openers: DialogOpeners): void {
  const contactModal = document.querySelector<HTMLElement>("[data-contact-modal]");
  const contactSuccess = document.querySelector<HTMLElement>("[data-contact-success]");
  const contactForm = document.querySelector<HTMLFormElement>("[data-contact-form]");
  const contactFirstInput = contactForm?.querySelector<HTMLElement>("input, textarea, button");

  document.querySelectorAll<HTMLButtonElement>("[data-contact-open]").forEach((button) => {
    button.addEventListener("click", () => {
      if (contactModal) {
        openers.contact = getActiveElement();
        contactModal.hidden = false;
        focusDialogElement(contactModal, contactFirstInput);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-contact-close]").forEach((button) => {
    button.addEventListener("click", () => closeContactModal(contactModal, openers.contact));
  });

  contactForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (contactSuccess) {
      contactSuccess.hidden = false;
    }
  });
}

function initializeEscapeKey(openers: DialogOpeners): void {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    closeSearchOverlay(document.querySelector<HTMLElement>("[data-search-overlay]"), openers.search);
    closePreviewDrawer(document.querySelector<HTMLElement>("[data-preview-drawer]"), openers.preview);
    closeContactModal(document.querySelector<HTMLElement>("[data-contact-modal]"), openers.contact);
  });
}

export function initializeHomeInteractions(): void {
  if (document.documentElement.dataset[INTERACTIONS_INITIALIZED_KEY] === "true") {
    return;
  }

  document.documentElement.dataset[INTERACTIONS_INITIALIZED_KEY] = "true";
  const queueStore = createQueueStore(getLocalStorage());
  const openers: DialogOpeners = {
    contact: null,
    preview: null,
    search: null,
  };

  initializeSearch(openers);
  initializeTopics();
  initializeQueue(queueStore);
  initializePreview(openers);
  initializeContact(openers);
  initializeEscapeKey(openers);
}

if (typeof document !== "undefined") {
  initializeHomeInteractions();
}
