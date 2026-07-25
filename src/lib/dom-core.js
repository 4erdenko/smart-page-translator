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

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  function containsStandaloneTerm(text, term) {
    return new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
      "iu"
    ).test(text);
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

  function splitTextForTranslation(value, maximumCharacters) {
    const text = normalizeText(value);
    const limit = Math.max(1, Math.floor(Number(maximumCharacters) || 1));
    const chunks = [];
    let start = 0;

    while (start < text.length) {
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

    return chunks;
  }

  function normalizeLanguageCode(value) {
    const match = String(value ?? "").trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_].*)?$/u);
    return match?.[1] || "";
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
    const normalizedWholeTerms = new Set(Array.from(wholeTerms || [], (term) => normalizeText(term).toLowerCase()));
    const normalizedTerms = new Map(Array.from(terms || [], normalizeText)
      .filter(Boolean)
      .map((term) => [term.toLowerCase(), term]));

    return [...normalizedTerms]
      .filter(([foldedTerm, term]) => foldedText.includes(foldedTerm)
        && containsStandaloneTerm(normalizedText, term)
        && (canProtectWholeText || foldedTerm !== foldedText || normalizedWholeTerms.has(foldedTerm)))
      .map(([, term]) => term)
      .sort((left, right) => right.length - left.length);
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
    findClosestTextKindElement,
    getBrandTermVariants,
    getImplicitOptionValue,
    getInheritedTextKind,
    getSafeContextText,
    getTranslatableAttributes,
    getTextKind,
    isBlockedAttributeElement,
    isBlockedElement,
    isEditableElement,
    isLikelyPersonalName,
    isValidBrandTerm,
    normalizeLanguageCode,
    normalizeText,
    resolveOriginalText,
    resolveRequestSourceLanguage,
    selectProtectedTerms,
    shouldAutoTranslateLanguage,
    shouldDetectPageLanguage,
    shouldRefreshRoutePolicy,
    shouldStartTranslation,
    shouldTranslateText,
    splitBoundaryWhitespace,
    splitTextForTranslation
  });
});
