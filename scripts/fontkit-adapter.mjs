import * as upstreamFontkit from "fontkit";

function createSubsetStream(subset) {
  const listeners = {
    data: [],
    end: [],
    error: []
  };
  const stream = {
    on(event, listener) {
      if (Object.hasOwn(listeners, event) && typeof listener === "function") {
        listeners[event].push(listener);
      }

      return stream;
    }
  };

  queueMicrotask(() => {
    try {
      const bytes = subset.encode();

      for (const listener of listeners.data) {
        listener(bytes);
      }

      for (const listener of listeners.end) {
        listener();
      }
    } catch (error) {
      for (const listener of listeners.error) {
        listener(error);
      }
    }
  });

  return stream;
}

function adaptFont(font) {
  const createSubset = font.createSubset.bind(font);

  font.createSubset = () => {
    const subset = createSubset();

    if (typeof subset.encodeStream !== "function") {
      subset.encodeStream = () => createSubsetStream(subset);
    }

    return subset;
  };

  return font;
}

export function create(...args) {
  return adaptFont(upstreamFontkit.create(...args));
}
