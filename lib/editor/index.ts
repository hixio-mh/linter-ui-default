

import { debounce } from "lodash";
import disposableEvent from "disposable-event";
import { CompositeDisposable, Disposable, Emitter, Range } from "atom";
// $FlowIgnore: Cursor is a type
import { TextEditor, DisplayMarker, Gutter, Point, Cursor } from "atom";

import Tooltip from "../tooltip";
import { $range, filterMessagesByRangeOrPoint } from "../helpers";
import { hasParent, mouseEventNearPosition, getBufferPositionFromMouseEvent } from "./helpers";
import { LinterMessage } from "../types";

class Editor {

  gutter: Gutter | null | undefined;
  tooltip: Tooltip | null | undefined;
  emitter: Emitter;
  markers: Map<string, Array<DisplayMarker>>;
  messages: Map<string, LinterMessage>;
  textEditor: TextEditor;
  showTooltip: boolean;
  subscriptions: CompositeDisposable;
  cursorPosition: Point | null | undefined;
  gutterPosition: boolean;
  tooltipFollows: string;
  showDecorations: boolean;
  showProviderName: boolean;
  ignoreTooltipInvocation: boolean;
  currentLineMarker: DisplayMarker | null | undefined;
  lastRange: Range | null | undefined;
  lastEmpty: Range | null | undefined;
  lastCursorPositions: WeakMap<Cursor, Point>;

  constructor(textEditor: TextEditor) {
    this.tooltip = null;
    this.emitter = new Emitter();
    this.markers = new Map();
    this.messages = new Map();
    this.textEditor = textEditor;
    this.subscriptions = new CompositeDisposable();
    this.ignoreTooltipInvocation = false;
    this.currentLineMarker = null;
    this.lastRange = null;
    this.lastEmpty = null;
    this.lastCursorPositions = new WeakMap();

    this.subscriptions.add(this.emitter);
    this.subscriptions.add(atom.config.observe('linter-ui-default.showTooltip', showTooltip => {
      this.showTooltip = showTooltip;
      if (!this.showTooltip && this.tooltip) {
        this.removeTooltip();
      }
    }));
    this.subscriptions.add(atom.config.observe('linter-ui-default.showProviderName', showProviderName => {
      this.showProviderName = showProviderName;
    }));
    this.subscriptions.add(atom.config.observe('linter-ui-default.showDecorations', showDecorations => {
      const notInitial = typeof this.showDecorations !== 'undefined';
      this.showDecorations = showDecorations;
      if (notInitial) {
        this.updateGutter();
      }
    }));
    this.subscriptions.add(atom.config.observe('linter-ui-default.gutterPosition', gutterPosition => {
      const notInitial = typeof this.gutterPosition !== 'undefined';
      this.gutterPosition = gutterPosition;
      if (notInitial) {
        this.updateGutter();
      }
    }));
    this.subscriptions.add(textEditor.onDidDestroy(() => {
      this.dispose();
    }));

    let tooltipSubscription;
    this.subscriptions.add(atom.config.observe('linter-ui-default.tooltipFollows', tooltipFollows => {
      this.tooltipFollows = tooltipFollows;
      if (tooltipSubscription) {
        tooltipSubscription.dispose();
      }
      tooltipSubscription = new CompositeDisposable();
      if (tooltipFollows === 'Mouse' || tooltipFollows === 'Both') {
        tooltipSubscription.add(this.listenForMouseMovement());
      }
      if (tooltipFollows === 'Keyboard' || tooltipFollows === 'Both') {
        tooltipSubscription.add(this.listenForKeyboardMovement());
      }
      this.removeTooltip();
    }));
    this.subscriptions.add(new Disposable(function () {
      tooltipSubscription.dispose();
    }));

    this.subscriptions.add(textEditor.onDidChangeCursorPosition(({
      cursor,
      newBufferPosition
    }) => {
      const lastBufferPosition = this.lastCursorPositions.get(cursor);
      if (!lastBufferPosition || !lastBufferPosition.isEqual(newBufferPosition)) {
        this.lastCursorPositions.set(cursor, newBufferPosition);
        this.ignoreTooltipInvocation = false;
      }
      if (this.tooltipFollows === 'Mouse') {
        this.removeTooltip();
      }
    }));
    this.subscriptions.add(textEditor.getBuffer().onDidChangeText(() => {
      const cursors = textEditor.getCursors();
      cursors.forEach(cursor => {
        this.lastCursorPositions.set(cursor, cursor.getBufferPosition());
      });
      if (this.tooltipFollows !== 'Mouse') {
        this.ignoreTooltipInvocation = true;
        this.removeTooltip();
      }
    }));
    this.updateGutter();
    this.listenForCurrentLine();
  }
  listenForCurrentLine() {
    this.subscriptions.add(this.textEditor.observeCursors(cursor => {
      const handlePositionChange = ({
        start,
        end
      }) => {
        const gutter = this.gutter;
        if (!gutter || this.subscriptions.disposed) return;
        // We need that Range.fromObject hack below because when we focus index 0 on multi-line selection
        // end.column is the column of the last line but making a range out of two and then accesing
        // the end seems to fix it (black magic?)
        const currentRange = Range.fromObject([start, end]);
        const linesRange = Range.fromObject([[start.row, 0], [end.row, Infinity]]);
        const currentEmpty = currentRange.isEmpty();

        // NOTE: Atom does not paint gutter if multi-line and last line has zero index
        if (start.row !== end.row && currentRange.end.column === 0) {
          linesRange.end.row--;
        }
        if (this.lastRange && this.lastRange.isEqual(linesRange) && currentEmpty === this.lastEmpty) return;
        if (this.currentLineMarker) {
          this.currentLineMarker.destroy();
          this.currentLineMarker = null;
        }
        this.lastRange = linesRange;
        this.lastEmpty = currentEmpty;

        this.currentLineMarker = this.textEditor.markScreenRange(linesRange, {
          invalidate: 'never'
        });
        const item = document.createElement('span');
        item.className = `line-number cursor-line linter-cursor-line ${currentEmpty ? 'cursor-line-no-selection' : ''}`;
        gutter.decorateMarker(this.currentLineMarker, {
          item,
          class: 'linter-row'
        });
      };

      const cursorMarker = cursor.getMarker();
      const subscriptions = new CompositeDisposable();
      subscriptions.add(cursorMarker.onDidChange(({
        newHeadScreenPosition,
        newTailScreenPosition
      }) => {
        handlePositionChange({
          start: newHeadScreenPosition,
          end: newTailScreenPosition
        });
      }));
      subscriptions.add(cursor.onDidDestroy(() => {
        this.subscriptions.remove(subscriptions);
        subscriptions.dispose();
      }));
      subscriptions.add(new Disposable(function () {
        if (this.currentLineMarker) {
          this.currentLineMarker.destroy();
          this.currentLineMarker = null;
        }
      }));
      this.subscriptions.add(subscriptions);
      handlePositionChange(cursorMarker.getScreenRange());
    }));
  }
  listenForMouseMovement() {
    const editorElement = atom.views.getView(this.textEditor);

    return disposableEvent(editorElement, 'mousemove', debounce(event => {
      if (!editorElement.component || this.subscriptions.disposed || !hasParent(event.target, 'div.scroll-view')) {
        return;
      }
      const tooltip = this.tooltip;
      if (tooltip && mouseEventNearPosition({
        event,
        editor: this.textEditor,
        editorElement,
        tooltipElement: tooltip.element,
        screenPosition: tooltip.marker.getStartScreenPosition()
      })) {
        return;
      }

      this.cursorPosition = getBufferPositionFromMouseEvent(event, this.textEditor, editorElement);
      this.ignoreTooltipInvocation = false;
      if (this.textEditor.largeFileMode) {
        // NOTE: Ignore if file is too large
        this.cursorPosition = null;
      }
      if (this.cursorPosition) {
        this.updateTooltip(this.cursorPosition);
      } else {
        this.removeTooltip();
      }
    }, 300, true));
  }
  listenForKeyboardMovement() {
    return this.textEditor.onDidChangeCursorPosition(debounce(({
      newBufferPosition
    }) => {
      this.cursorPosition = newBufferPosition;
      this.updateTooltip(newBufferPosition);
    }, 16));
  }
  updateGutter() {
    this.removeGutter();
    if (!this.showDecorations) {
      this.gutter = null;
      return;
    }
    const priority = this.gutterPosition === 'Left' ? -100 : 100;
    this.gutter = this.textEditor.addGutter({
      name: 'linter-ui-default',
      priority
    });
    this.markers.forEach((markers: Array<DisplayMarker>, key: string) => {
      const message = this.messages.get(key);
      if (message) {
        for (const marker of markers) {
          this.decorateMarker(message, marker, 'gutter');
        }
      }
    });
  }
  removeGutter() {
    if (this.gutter) {
      try {
        this.gutter.destroy();
      } catch (_) {
        /* This throws when the text editor is disposed */
      }
    }
  }
  updateTooltip(position: Point | null | undefined) {
    if (!position || (this.tooltip && this.tooltip.isValid(position, this.messages))) {
      return;
    }
    this.removeTooltip();
    if (!this.showTooltip) {
      return;
    }
    if (this.ignoreTooltipInvocation) {
      return;
    }

    const messages = filterMessagesByRangeOrPoint(this.messages, this.textEditor.getPath(), position);
    if (!messages.length) {
      return;
    }

    this.tooltip = new Tooltip(messages, position, this.textEditor);

    // save markers of the tooltip (for destorying them in this.apply)
    messages.forEach(message => {
      // $FlowIgnore: this.tooltip is not null
      this.saveMarker(message.key, this.tooltip.marker);
    });

    // $FlowIgnore: this.tooltip is not null
    this.tooltip.onDidDestroy(() => {
      this.tooltip = null;
    });
  }
  removeTooltip() {
    if (this.tooltip) {
      this.tooltip.marker.destroy();
    }
  }
  apply(added: Array<LinterMessage>, removed: Array<LinterMessage>) {
    const textBuffer = this.textEditor.getBuffer();

    for (let i = 0, length = removed.length; i < length; i++) {
      const message = removed[i];
      this.destroyMarker(message.key);
    }

    for (let i = 0, length = added.length; i < length; i++) {
      const message = added[i];
      const markerRange = $range(message);
      if (!markerRange) {
        // Only for backward compatibility
        continue;
      }
      const marker = textBuffer.markRange(markerRange, {
        invalidate: 'never'
      });
      this.decorateMarker(message, marker);
      marker.onDidChange(({
        oldHeadPosition,
        newHeadPosition,
        isValid
      }) => {
        if (!isValid || (newHeadPosition.row === 0 && oldHeadPosition.row !== 0)) {
          return;
        }
        if (message.version === 2) {
          message.location.position = marker.previousEventState.range;
        }
      });
    }

    this.updateTooltip(this.cursorPosition);
  }
  decorateMarker(message: LinterMessage, marker: DisplayMarker, paint: "gutter" | "editor" | "both" = 'both') {
    this.saveMarker(message.key, marker);
    this.messages.set(message.key, message);

    if (paint === 'both' || paint === 'editor') {
      this.textEditor.decorateMarker(marker, {
        type: 'text',
        class: `linter-highlight linter-${message.severity}`
      });
    }

    const gutter = this.gutter;
    if (gutter && (paint === 'both' || paint === 'gutter')) {
      const element = document.createElement('span');
      element.className = `linter-gutter linter-gutter-${message.severity} icon icon-${message.icon || 'primitive-dot'}`;
      gutter.decorateMarker(marker, {
        class: 'linter-row',
        item: element
      });
    }
  }

  // add marker to the message => marker map
  saveMarker(key: string, marker: DisplayMarker) {
    const allMarkers = this.markers.get(key) || [];
    allMarkers.push(marker);
    this.markers.set(key, allMarkers);
  }

  // destroy markers of a key
  destroyMarker(key: string) {
    const markers = this.markers.get(key);
    if (markers) {
      markers.forEach(marker => {
        if (marker) {
          marker.destroy();
        }
      });
    }
    this.markers.delete(key);
    this.messages.delete(key);
  }

  onDidDestroy(callback: Function): Disposable {
    return this.emitter.on('did-destroy', callback);
  }
  dispose() {
    this.emitter.emit('did-destroy');
    this.subscriptions.dispose();
    this.removeGutter();
    this.removeTooltip();
  }
}

module.exports = Editor;