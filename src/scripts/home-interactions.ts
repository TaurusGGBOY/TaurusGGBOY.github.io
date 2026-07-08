import {
  QUEUE_STORAGE_KEY,
  addQueuedSlug,
  deserializeQueuedSlugs,
  serializeQueuedSlugs,
} from "../lib/queue";

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

function getQueuedSlugs(): string[] {
  return deserializeQueuedSlugs(window.localStorage.getItem(QUEUE_STORAGE_KEY));
}

function setQueuedSlugs(slugs: string[]): void {
  window.localStorage.setItem(QUEUE_STORAGE_KEY, serializeQueuedSlugs(slugs));
}

function updateQueueCounts(count: number): void {
  document.querySelectorAll<HTMLElement>("[data-queue-count]").forEach((counter) => {
    counter.textContent = String(count);
  });
}

function closeSearchOverlay(searchOverlay: HTMLElement | null): void {
  if (searchOverlay) {
    searchOverlay.hidden = true;
  }
}

function closePreviewDrawer(previewDrawer: HTMLElement | null): void {
  if (previewDrawer) {
    previewDrawer.hidden = true;
  }
}

function closeContactModal(contactModal: HTMLElement | null): void {
  if (contactModal) {
    contactModal.hidden = true;
  }
}

function initializeSearch(): void {
  const searchOverlay = document.querySelector<HTMLElement>("[data-search-overlay]");
  const searchInput = document.querySelector<HTMLInputElement>("[data-search-input]");
  const searchResults = Array.from(document.querySelectorAll<HTMLElement>("[data-search-result]"));
  const searchForm = searchInput?.closest("form");

  document.querySelectorAll<HTMLButtonElement>("[data-search-open]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!searchOverlay) {
        return;
      }

      searchOverlay.hidden = false;
      window.requestAnimationFrame(() => searchInput?.focus());
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-search-close]").forEach((button) => {
    button.addEventListener("click", () => closeSearchOverlay(searchOverlay));
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
  };

  topicButtons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => setActiveTopic(button.dataset.topic ?? null));
  });

  topicReset?.addEventListener("click", () => setActiveTopic(null));
}

function initializeQueue(): void {
  updateQueueCounts(getQueuedSlugs().length);

  document.querySelectorAll<HTMLButtonElement>("[data-queue-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.queueAdd;
      if (!slug) {
        return;
      }

      const queuedSlugs = addQueuedSlug(getQueuedSlugs(), slug);
      setQueuedSlugs(queuedSlugs);
      updateQueueCounts(queuedSlugs.length);
    });
  });
}

function initializePreview(): void {
  const previewDrawer = document.querySelector<HTMLElement>("[data-preview-drawer]");
  const previewPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-preview-panel]"));

  document.querySelectorAll<HTMLButtonElement>("[data-preview-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.previewOpen;
      if (!previewDrawer || !slug) {
        return;
      }

      previewPanels.forEach((panel) => {
        panel.hidden = panel.dataset.previewPanel !== slug;
      });
      previewDrawer.hidden = false;
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-preview-close]").forEach((button) => {
    button.addEventListener("click", () => closePreviewDrawer(previewDrawer));
  });
}

function initializeContact(): void {
  const contactModal = document.querySelector<HTMLElement>("[data-contact-modal]");
  const contactSuccess = document.querySelector<HTMLElement>("[data-contact-success]");
  const contactForm = document.querySelector<HTMLFormElement>("[data-contact-form]");

  document.querySelectorAll<HTMLButtonElement>("[data-contact-open]").forEach((button) => {
    button.addEventListener("click", () => {
      if (contactModal) {
        contactModal.hidden = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-contact-close]").forEach((button) => {
    button.addEventListener("click", () => closeContactModal(contactModal));
  });

  contactForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (contactSuccess) {
      contactSuccess.hidden = false;
    }
  });
}

function initializeEscapeKey(): void {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    closeSearchOverlay(document.querySelector<HTMLElement>("[data-search-overlay]"));
    closePreviewDrawer(document.querySelector<HTMLElement>("[data-preview-drawer]"));
    closeContactModal(document.querySelector<HTMLElement>("[data-contact-modal]"));
  });
}

export function initializeHomeInteractions(): void {
  initializeSearch();
  initializeTopics();
  initializeQueue();
  initializePreview();
  initializeContact();
  initializeEscapeKey();
}

if (typeof document !== "undefined") {
  initializeHomeInteractions();
}
