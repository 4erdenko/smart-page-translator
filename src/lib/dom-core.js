(function initializeDomCore(root, factory) {
  const api = factory();
  root.SmartTranslationDomCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createDomCore() {
  const BLOCKED_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "TEXTAREA",
    "OBJECT",
    "EMBED",
    "CANVAS"
  ]);
  const TRANSLATABLE_ATTRIBUTES = Object.freeze([
    "alt",
    "aria-description",
    "aria-label",
    "placeholder",
    "title"
  ]);
  const INTERFACE_TAGS = new Set(["BUTTON", "INPUT", "OPTION", "OPTGROUP", "SELECT"]);
  const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
  const FORM_FIELD_TAGS = new Set(["INPUT", "LABEL", "OPTGROUP", "OPTION", "SELECT", "TEXTAREA"]);
  const PROFILE_ACTION_WORDS = new Set([
    "abmelden", "accedi", "account", "address", "addresses", "adres", "adresse", "adressen",
    "adresy", "aide", "aiuto", "ajuda", "ajustes", "anmelden", "ayuda", "bestelling",
    "bestellingen", "betaling", "betalingen", "billing", "cerrar", "commande", "commandes",
    "compte", "connexion", "conta", "cuenta", "definições", "déconnexion", "dirección",
    "direcciones", "disconnetti", "einstellung", "einstellungen", "endereço", "endereços",
    "entrar", "esci", "favorite", "favorites", "favori", "favoris", "favorito", "favoritos",
    "gebruiker", "help", "hilfe", "hulp", "impostazioni", "indirizzi", "indirizzo", "inloggen",
    "instelling", "instellingen", "konto", "login", "logout", "morada", "moradas", "order",
    "orders", "ordine", "ordini", "pagamenti", "pagamento", "pagamentos", "pago", "pagos",
    "paiement", "paiements", "paramètres", "payment", "payments", "pedido", "pedidos", "perfil",
    "płatności", "płatność", "pomoc", "preference", "preferences", "preferiti", "preferito",
    "profile", "profil", "profilo", "sair", "salir", "security", "setting", "settings", "sign",
    "support", "uitloggen", "user", "usuario", "utente", "utilisateur", "utilizador",
    "ustawienia", "ustawienie", "użytkownik", "wallet", "wyloguj", "zaloguj", "zahlung",
    "zahlungen", "zamówienia", "zamówienie", "акаунт", "адрес", "адреса", "вийти", "войти",
    "допомога", "заказ", "заказы", "замовлення", "избранное", "користувач", "налаштування",
    "настройка", "настройки", "обране", "платежи", "платежі", "платёж", "платіж",
    "пользователь", "помощь", "профиль", "профіль", "увійти"
  ]);

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFC")
      .replace(/[\s\u00a0]+/gu, " ")
      .trim();
  }

  function hasMeaningfulText(value) {
    return /[^\s\u00a0]/u.test(String(value ?? ""));
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  function createProtectedTermIndex(terms, wholeTerms = []) {
    const normalizedWholeTerms = new Set(Array.from(
      wholeTerms || [],
      (term) => normalizeText(term).toLowerCase()
    ));
    const normalizedTerms = new Map(Array.from(terms || [], normalizeText)
      .filter(Boolean)
      .map((term) => [term.toLowerCase(), term]));
    const entries = [...normalizedTerms]
      .map(([foldedTerm, term]) => ({
        foldedTerm,
        matcher: new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
          "iu"
        ),
        term
      }))
      .sort((left, right) => right.term.length - left.term.length);

    return Object.freeze({
      entries: Object.freeze(entries),
      wholeTerms: normalizedWholeTerms
    });
  }

  function getUtf8ByteLength(value) {
    const text = String(value ?? "");
    let bytes = 0;

    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);

      if (code <= 0x7F) {
        bytes += 1;
      } else if (code <= 0x7FF) {
        bytes += 2;
      } else if (code >= 0xD800
        && code <= 0xDBFF
        && text.charCodeAt(index + 1) >= 0xDC00
        && text.charCodeAt(index + 1) <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    }

    return bytes;
  }

  function isTextWithinLimits(value, maximumCharacters, maximumBytes) {
    const text = String(value ?? "");
    return text.length <= Math.max(0, Number(maximumCharacters) || 0)
      && getUtf8ByteLength(text) <= Math.max(0, Number(maximumBytes) || 0);
  }

  function isWithinTextBudget(current, additional, maximum) {
    return Number(current?.characters || 0) + Number(additional?.characters || 0)
        <= Number(maximum?.characters || 0)
      && Number(current?.bytes || 0) + Number(additional?.bytes || 0)
        <= Number(maximum?.bytes || 0);
  }

  function getPendingQueueDecision(current, additional, maximum) {
    const fitsWhenEmpty = Number(additional?.targets || 0) <= Number(maximum?.targets || 0)
      && isWithinTextBudget({}, additional, maximum);

    if (!fitsWhenEmpty) {
      return "reject";
    }

    return Number(current?.targets || 0) + Number(additional?.targets || 0)
        <= Number(maximum?.targets || 0)
      && isWithinTextBudget(current, additional, maximum)
      ? "queue"
      : "retry";
  }

  function isValidBrandTerm(value) {
    const term = normalizeText(value);
    return term.length >= 2
      && term.length <= 80
      && /^(?=.*\p{L})[\p{L}\p{N}][\p{L}\p{N}\p{Pd} .&'’+]*(?:[®™℠])?$/u.test(term);
  }

  function getBrandTermVariants(value) {
    const term = normalizeText(value);
    const withoutTrademark = normalizeText(term.replace(/[®™℠]+$/u, ""));
    return [...new Set([
      term,
      term.replace(/\p{Pd}/gu, "-"),
      withoutTrademark,
      withoutTrademark.replace(/\p{Pd}/gu, "-")
    ])].filter(isValidBrandTerm);
  }

  function splitBoundaryWhitespace(value) {
    const match = String(value ?? "").match(/^(\s*)([\s\S]*?)(\s*)$/u);
    return {
      leading: match?.[1] ?? "",
      core: match?.[2] ?? "",
      trailing: match?.[3] ?? ""
    };
  }

  function splitTextForTranslation(
    value,
    maximumCharacters,
    preserveWhitespace = false,
    maximumChunks = Infinity
  ) {
    const chunkLimit = Math.max(1, Math.floor(Number(maximumChunks) || 1));

    if (preserveWhitespace) {
      const text = String(value ?? "").normalize("NFC");
      const chunks = [];
      let start = 0;

      for (const match of text.matchAll(/\s+/gu)) {
        const separator = match[0];

        if (separator === " ") {
          continue;
        }

        const remainingChunks = chunkLimit - chunks.length;

        if (remainingChunks <= 0) {
          chunks[chunks.length - 1].separator += text.slice(start);
          return chunks;
        }

        const segmentChunks = splitTextForTranslation(
          text.slice(start, match.index),
          maximumCharacters,
          false,
          remainingChunks
        );

        if (segmentChunks.length > 0) {
          segmentChunks[segmentChunks.length - 1].separator += separator;
          chunks.push(...segmentChunks);
        } else if (chunks.length > 0) {
          chunks[chunks.length - 1].separator += separator;
        }

        start = match.index + separator.length;

        if (chunks.length >= chunkLimit) {
          chunks[chunks.length - 1].separator += text.slice(start);
          return chunks;
        }
      }

      chunks.push(...splitTextForTranslation(
        text.slice(start),
        maximumCharacters,
        false,
        chunkLimit - chunks.length
      ));
      return chunks;
    }

    const text = normalizeText(value);
    const limit = Math.max(1, Math.floor(Number(maximumCharacters) || 1));
    const chunks = [];
    let start = 0;

    while (start < text.length && chunks.length < chunkLimit) {
      let end = Math.min(text.length, start + limit);
      let nextStart = end;
      let separator = "";

      if (end < text.length) {
        const space = text.lastIndexOf(" ", end);

        if (space > start) {
          end = space;
          nextStart = space + 1;
          separator = " ";
        } else if (text.charCodeAt(end - 1) >= 0xD800
          && text.charCodeAt(end - 1) <= 0xDBFF
          && text.charCodeAt(end) >= 0xDC00
          && text.charCodeAt(end) <= 0xDFFF) {
          end += 1;
          nextStart = end;
        }
      }

      chunks.push({ separator, text: text.slice(start, end) });
      start = nextStart;
    }

    if (start < text.length) {
      chunks[chunks.length - 1].separator += text.slice(start);
    }

    return chunks;
  }

  function normalizeLanguageCode(value) {
    const match = String(value ?? "").trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_].*)?$/u);
    return match?.[1] || "";
  }

  function getPageContextChange(currentUrl, currentLanguage, nextUrl, nextLanguage) {
    const languageChanged = normalizeLanguageCode(currentLanguage) !== normalizeLanguageCode(nextLanguage);
    const urlChanged = String(currentUrl ?? "") !== String(nextUrl ?? "");

    return {
      changed: languageChanged || urlChanged,
      languageChanged,
      urlChanged
    };
  }

  function addPageLanguageContext(context, pageLanguage) {
    const language = normalizeLanguageCode(pageLanguage);

    return [normalizeText(context), language ? `page-language:${language}` : ""]
      .filter(Boolean)
      .join("; ");
  }

  function shouldAutoTranslateLanguage(detectedLanguage, selectedLanguages, targetLanguage) {
    const detected = normalizeLanguageCode(detectedLanguage);
    const target = normalizeLanguageCode(targetLanguage);
    const selected = new Set((Array.isArray(selectedLanguages) ? selectedLanguages : []).map(normalizeLanguageCode));
    return Boolean(detected && detected !== target && selected.has(detected));
  }

  function shouldDetectPageLanguage({
    declaredLanguage,
    selectedLanguages,
    siteMode,
    sourceLanguage,
    targetLanguage
  }) {
    if (siteMode === "always") {
      const normalizedDeclaredLanguage = normalizeLanguageCode(declaredLanguage);
      return sourceLanguage === "auto"
        && (!normalizedDeclaredLanguage || normalizedDeclaredLanguage === "und");
    }

    return siteMode === "auto"
      && Array.isArray(selectedLanguages)
      && selectedLanguages.length > 0
      && !shouldAutoTranslateLanguage(declaredLanguage, selectedLanguages, targetLanguage);
  }

  function shouldRefreshRoutePolicy(siteMode, sourceLanguage) {
    return siteMode === "auto" || (siteMode === "always" && sourceLanguage === "auto");
  }

  function shouldStartTranslation({ enabled, error, translationChanged, wasEnabled }) {
    return Boolean(enabled && (!wasEnabled || translationChanged || error));
  }

  function resolveRequestSourceLanguage(configuredLanguage) {
    return configuredLanguage === "auto" ? "auto" : configuredLanguage;
  }

  function resolveOriginalText(value, record) {
    const text = String(value ?? "");
    return record && (text === record.translated || text === record.displayed)
      ? String(record.original ?? "")
      : text;
  }

  function shouldTranslateText(value) {
    const normalized = normalizeText(value);

    if (!normalized || !/\p{L}/u.test(normalized)) {
      return false;
    }

    if (/^(?:https?:\/\/|mailto:|tel:|www\.)\S+$/iu.test(normalized)) {
      return false;
    }

    return true;
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }

    if (element.isContentEditable) {
      return true;
    }

    const tagName = element.tagName;
    return tagName === "TEXTAREA"
      || (tagName === "INPUT" && !["button", "reset", "submit"].includes(String(element.type).toLowerCase()));
  }

  function isBlockedElement(element) {
    let current = element;

    while (current) {
      if (BLOCKED_TAGS.has(current.tagName)) {
        return true;
      }

      if (isEditableElement(current)) {
        return true;
      }

      if (current.hasAttribute?.("data-no-translate")) {
        return true;
      }

      current = current.parentElement || current.getRootNode?.().host || null;
    }

    return false;
  }

  function isBlockedAttributeElement(element) {
    if (!element || element.hasAttribute?.("data-no-translate")) {
      return true;
    }

    if (!isEditableElement(element)) {
      return isBlockedElement(element);
    }

    return isBlockedElement(element.parentElement || element.getRootNode?.().host || null);
  }

  function isGuaranteedBlockedSubtree(element) {
    if (!element) {
      return false;
    }

    if (element.hasAttribute?.("data-no-translate")) {
      return true;
    }

    if (isEditableElement(element)) {
      return isBlockedElement(element.parentElement || element.getRootNode?.().host || null);
    }

    return isBlockedElement(element);
  }

  function isWhitespaceSensitiveElement(element, readWhiteSpace) {
    if (!element) {
      return false;
    }

    if (element.closest?.("pre")) {
      return true;
    }

    try {
      const whiteSpace = String(readWhiteSpace
        ? readWhiteSpace(element)
        : globalThis.getComputedStyle?.(element)?.whiteSpace || "").toLowerCase();
      return ["break-spaces", "pre", "pre-line", "pre-wrap"].includes(whiteSpace);
    } catch {
      return false;
    }
  }

  function shouldPreserveTextWhitespace(element, value, readWhiteSpace) {
    return /[^\S ]|\s{2,}/u.test(String(value ?? ""))
      && isWhitespaceSensitiveElement(element, readWhiteSpace);
  }

  function getSafeContextText(element, maximumCharacters) {
    const limit = Math.max(1, Math.floor(Number(maximumCharacters) || 1));

    if (!element || Number(element.childElementCount || 0) > 0 || isBlockedElement(element)) {
      return "";
    }

    const text = normalizeText(element.textContent);
    return text.length <= limit ? text : "";
  }

  function getImplicitOptionValue(element) {
    if (element?.tagName !== "OPTION" || element.hasAttribute?.("value")) {
      return null;
    }

    return String(element.value ?? "");
  }

  function getElementDescriptor(element) {
    if (!element) {
      return "";
    }

    const className = typeof element.className === "string" ? element.className : element.className?.baseVal;
    return [
      element.tagName,
      element.id,
      className,
      element.getAttribute?.("data-testid"),
      element.getAttribute?.("data-test"),
      element.getAttribute?.("data-qa"),
      element.getAttribute?.("itemprop"),
      element.getAttribute?.("role")
    ].filter(Boolean)
      .map((value) => String(value)
        .replace(/(\p{Ll}|\p{Nd})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2"))
      .join(" ")
      .toLowerCase();
  }

  function hasProductDescriptor(element) {
    const descriptor = getElementDescriptor(element);

    if (/(?:^|[\s_-])(?:product|dish|goods|sku)(?:$|[\s_-])/iu.test(descriptor)) {
      return true;
    }

    return /(?:^|[\s_-])item(?:$|[\s_-])/iu.test(descriptor)
      && /(?:^|[\s_-])(?:name|title)(?:$|[\s_-])/iu.test(descriptor);
  }

  function getClosestItemScope(element, maximumDepth = 6) {
    let current = element;
    let depth = 0;

    while (current && depth < maximumDepth) {
      const itemType = String(current.getAttribute?.("itemtype") || "").toLowerCase();

      if (itemType) {
        return {
          itemProperty: String(current.getAttribute?.("itemprop") || "").toLowerCase(),
          itemType
        };
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function getTextKind(element) {
    const descriptor = getElementDescriptor(element);
    const itemProperty = String(element?.getAttribute?.("itemprop") || "").toLowerCase();
    const hasNameItemProperty = /(?:^|\s)name(?:$|\s)/u.test(itemProperty);
    const itemScope = hasNameItemProperty ? getClosestItemScope(element) : null;
    const itemType = itemScope?.itemType || "";
    const hasBrandMarker = /(?:^|\s)brand(?:$|\s)/u.test(itemProperty)
      || (hasNameItemProperty && /(?:^|\s)brand(?:$|\s)/u.test(itemScope?.itemProperty || ""))
      || /(?:^|[\s_-])(?:brand|manufacturer|maker)(?:$|[\s_-])/iu.test(descriptor)
      || (/(?:^|[\s_-])(?:merchant|restaurant|store|vendor)(?:$|[\s_-])/iu.test(descriptor)
        && /(?:^|[\s_-])(?:name|title)(?:$|[\s_-])/iu.test(descriptor));

    if (hasBrandMarker) {
      return "brand-name";
    }

    const hasProperNameDescriptor = /(?:^|[\s_-])(?:(?:display|user|profile|customer|author|seller|account)[\s_-]?name|avatar)(?:$|[\s_-])/iu.test(descriptor);
    const isFormFieldNameMarker = hasProperNameDescriptor
      && (FORM_FIELD_TAGS.has(element?.tagName)
        || Boolean(element?.closest?.("label"))
        || /(?:^|[\s_-])(?:field|input|label|placeholder)(?:$|[\s_-])/iu.test(descriptor));
    const hasProperNameMarker = (hasProperNameDescriptor && !isFormFieldNameMarker)
      || (hasNameItemProperty && /schema\.org\/(?:person|organization|place)/iu.test(itemType));

    if (hasProperNameMarker) {
      return "proper-name";
    }

    const hasProductMarker = hasProductDescriptor(element);
    const hasNameMarker = hasNameItemProperty
      || /(?:^|[\s_-])(?:name|title)(?:$|[\s_-])/iu.test(descriptor);

    if (hasProductMarker && hasNameMarker) {
      return "product-title";
    }

    if (HEADING_TAGS.has(element?.tagName) || hasNameMarker) {
      let current = element?.parentElement;
      let depth = 0;

      while (current && depth < 4) {
        if (hasProductDescriptor(current)) {
          return "product-title";
        }

        current = current.parentElement;
        depth += 1;
      }
    }

    if (INTERFACE_TAGS.has(element?.tagName) || element?.getAttribute?.("role") === "button") {
      return "interface";
    }

    if (HEADING_TAGS.has(element?.tagName)) {
      return "heading";
    }

    return "text";
  }

  function findClosestTextKindElement(element, kind, maximumDepth = 4) {
    let current = element;
    let depth = 0;

    while (current && depth < maximumDepth) {
      if (getTextKind(current) === kind) {
        return current;
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function getInheritedTextKind(element) {
    const kind = getTextKind(element);
    return kind !== "brand-name" && findClosestTextKindElement(element?.parentElement, "brand-name", 3)
      ? "brand-name"
      : kind;
  }

  function selectProtectedTerms(text, terms, kind, wholeTerms = []) {
    const normalizedText = normalizeText(text);
    const foldedText = normalizedText.toLowerCase();
    const canProtectWholeText = kind === "brand-name" || kind === "proper-name";
    const index = Array.isArray(terms?.entries) && terms?.wholeTerms instanceof Set
      ? terms
      : createProtectedTermIndex(terms, wholeTerms);

    return index.entries
      .filter(({ foldedTerm, matcher }) => foldedText.includes(foldedTerm)
        && matcher.test(normalizedText)
        && (canProtectWholeText || foldedTerm !== foldedText || index.wholeTerms.has(foldedTerm)))
      .map(({ term }) => term);
  }

  function discoverOpenShadowRoots(walker, maximumNodes, visitRoot) {
    const limit = Math.max(1, Math.floor(Number(maximumNodes) || 1));
    let node = null;
    let processed = 0;

    while (processed < limit && (node = walker.nextNode())) {
      if (node.shadowRoot) {
        visitRoot(node.shadowRoot);
      }

      processed += 1;
    }

    return {
      budgetUsed: Math.max(1, processed),
      complete: node === null,
      processed
    };
  }

  function discoverOpenShadowRootsAcrossReferences({
    createWalker,
    isRootActive,
    iterator,
    maximumWork,
    referencesRemaining,
    visitRoot,
    walkers
  }) {
    const incompleteReferences = [];
    const limit = Math.max(1, Math.floor(Number(maximumWork) || 1));
    let remainingReferences = Math.max(0, Math.floor(Number(referencesRemaining) || 0));
    let remainingWork = limit;

    while (remainingWork > 0 && remainingReferences > 0) {
      const next = iterator.next();

      if (next.done) {
        remainingReferences = 0;
        break;
      }

      remainingReferences -= 1;
      const root = next.value?.deref?.();

      if (!root || !isRootActive(root)) {
        if (root) {
          walkers.delete(root);
        }

        remainingWork -= 1;
        continue;
      }

      const walker = walkers.get(root) || createWalker(root);
      const rootsToShare = Math.min(remainingWork, remainingReferences + 1);
      const result = discoverOpenShadowRoots(
        walker,
        Math.max(1, Math.floor(remainingWork / rootsToShare)),
        visitRoot
      );
      remainingWork -= result.budgetUsed;

      if (result.complete) {
        walkers.delete(root);
      } else {
        walkers.set(root, walker);
        incompleteReferences.push(next.value);
      }
    }

    return {
      complete: remainingReferences === 0,
      incomplete: incompleteReferences.length > 0,
      incompleteReferences,
      processed: limit - remainingWork,
      referencesRemaining: remainingReferences
    };
  }

  function getShadowDiscoveryDelay(passComplete, sliceDelay, passDelay) {
    const delay = passComplete ? passDelay : sliceDelay;
    return Math.max(1, Math.floor(Number(delay) || 1));
  }

  function shouldRunShadowDiscoveryRetryRound(
    retryReferenceCount,
    completedRetryRounds,
    maximumRetryRounds
  ) {
    const limit = Math.max(1, Math.floor(Number(maximumRetryRounds) || 1));
    return Number(retryReferenceCount) > 0 && Number(completedRetryRounds) < limit;
  }

  function shouldPruneScanNode(node, elementNodeType = 1) {
    return node?.nodeType === elementNodeType && isGuaranteedBlockedSubtree(node);
  }

  function shouldRunShadowDiscovery(translationActive, visibilityState) {
    return Boolean(translationActive && visibilityState === "visible");
  }

  function isLikelyPersonalName(element, value, kind) {
    if (kind === "proper-name") {
      return true;
    }

    const interactiveElement = element?.closest?.('button, [role="button"]');
    const descriptor = getElementDescriptor(interactiveElement);

    if (!interactiveElement || !/(?:^|[\s_-])(?:account|avatar|customer|profile|user)(?:$|[\s_-])/iu.test(descriptor)) {
      return false;
    }

    const text = normalizeText(value);
    const words = text.split(" ");
    const hasActionWord = text.toLocaleLowerCase()
      .split(/[^\p{L}]+/u)
      .some((word) => PROFILE_ACTION_WORDS.has(word));
    return words.length === 1
      && text.length <= 60
      && !hasActionWord
      && words.every((word) => /^\p{Lu}[\p{L}'’.-]*$/u.test(word));
  }

  function getTranslatableAttributes(element) {
    const attributes = [...TRANSLATABLE_ATTRIBUTES];
    const tagName = element?.tagName;

    const inputType = String(element?.type).toLowerCase();
    const safeInputButton = tagName === "INPUT"
      && (["button", "reset"].includes(inputType) || (inputType === "submit" && !element.name));

    if (safeInputButton) {
      attributes.push("value");
    }

    if (tagName === "OPTION" || tagName === "OPTGROUP") {
      attributes.push("label");
    }

    return attributes;
  }

  return Object.freeze({
    BLOCKED_TAGS,
    TRANSLATABLE_ATTRIBUTES,
    addPageLanguageContext,
    createProtectedTermIndex,
    discoverOpenShadowRoots,
    discoverOpenShadowRootsAcrossReferences,
    findClosestTextKindElement,
    getBrandTermVariants,
    getImplicitOptionValue,
    getInheritedTextKind,
    getPageContextChange,
    getPendingQueueDecision,
    getSafeContextText,
    getShadowDiscoveryDelay,
    getTranslatableAttributes,
    getTextKind,
    getUtf8ByteLength,
    hasMeaningfulText,
    isBlockedAttributeElement,
    isBlockedElement,
    isEditableElement,
    isGuaranteedBlockedSubtree,
    isLikelyPersonalName,
    isTextWithinLimits,
    isValidBrandTerm,
    isWhitespaceSensitiveElement,
    isWithinTextBudget,
    normalizeLanguageCode,
    normalizeText,
    resolveOriginalText,
    resolveRequestSourceLanguage,
    selectProtectedTerms,
    shouldAutoTranslateLanguage,
    shouldDetectPageLanguage,
    shouldPruneScanNode,
    shouldPreserveTextWhitespace,
    shouldRefreshRoutePolicy,
    shouldRunShadowDiscovery,
    shouldRunShadowDiscoveryRetryRound,
    shouldStartTranslation,
    shouldTranslateText,
    splitBoundaryWhitespace,
    splitTextForTranslation
  });
});
