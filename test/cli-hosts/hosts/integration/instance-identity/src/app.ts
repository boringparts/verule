import {
  Disposable,
  type IDisposable,
  type IMenuService,
  createUntracked,
} from "@acme/lifecycle";

import { createResource as makeRes, passthrough } from "./helpers.js";

function release(item: IDisposable): void {
  item.dispose();
}

export class BadController extends Disposable {
  private _current: IDisposable;
  constructor(menuService: IMenuService) {
    super();
    const first = this._register(makeRes());
    const second = menuService.createMenu(1);
    this._current = first;
    // Bug: releases `second` instead of `this._current` (`first`).
    release(second);
    const untracked = createUntracked();
    void untracked;
  }
}

export class GoodController extends Disposable {
  private _current: IDisposable;
  constructor() {
    super();
    const first = this._register(makeRes());
    this._current = passthrough(first);
    const fn = () => release(this._current);
    void fn;
  }
}
