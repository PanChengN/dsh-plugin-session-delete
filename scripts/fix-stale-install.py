#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix-stale-install.py —— 清理「插件目录被删掉，但 profile 里还留着引用」造成的悬空安装。

症状（把从 GitHub clone 的插件目录直接 rm -rf 之后）：
  · DeepSeek Harness 启动异常 / 插件清单里出现失败条目 / 界面提示「加载失败；点击重试」
  · 宿主报：dsh: cannot resolve profile bundle "@local/dsh-bundle-session-delete" ...

原因：DSH 的 path 安装是把绝对路径写进 profile，共留下三处引用，
      删掉目录后它们全部悬空（详见仓库 README「卸载与换设备」）：
        1. profiles/<p>/package.json   → dependencies 里的 link: 与 dsh.profile.bundles
        2. profiles/<p>/node_modules/  → 指向已删目录的符号链接
        3. profiles/<p>/cordis.yml     → Loader 真正启动的 leaf 配置里那一行

默认只报告（dry-run），加 --apply 才写入；写入前每个文件都会备份为 *.bak-<时间戳>。

用法：
  python3 fix-stale-install.py                  # 只检查
  python3 fix-stale-install.py --apply          # 执行清理
  python3 fix-stale-install.py --dsh-home /path # 指定 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys

STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def dsh_home_from(default):
    if default:
        return os.path.abspath(os.path.expanduser(default))
    env = os.environ.get("DSH_HOME")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.expanduser("~/.dsh")


def link_target(spec):
    """`link:...` / `file:...` 依赖的本地目标路径；不是本地路径则返回 None。"""
    if not isinstance(spec, str):
        return None
    for prefix in ("link:", "file:"):
        if spec.startswith(prefix):
            return os.path.abspath(os.path.expanduser(spec[len(prefix):]))
    return None


def backup(path):
    dst = f"{path}.bak-{STAMP}"
    shutil.copy2(path, dst)
    return dst


def scan_manifests(home):
    """返回 [(profile_dir, manifest_path, 悬空依赖, 错误, 未解析的 bundle, manifest), ...]"""
    found = []
    profiles = os.path.join(home, "profiles")
    if not os.path.isdir(profiles):
        return found
    for name in sorted(os.listdir(profiles)):
        pdir = os.path.join(profiles, name)
        mpath = os.path.join(pdir, "package.json")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath, encoding="utf-8") as fh:
                manifest = json.load(fh)
        except Exception as exc:  # 损坏的 manifest 不动它，只报告
            found.append((pdir, mpath, [], f"读取失败：{exc}", [], None))
            continue
        deps = manifest.get("dependencies") or {}
        stale = []
        for pkg, spec in deps.items():
            target = link_target(spec)
            if target is not None and not os.path.isdir(target):
                stale.append((pkg, target))
        bundles = ((manifest.get("dsh") or {}).get("profile") or {}).get("bundles") or []
        unresolved = []
        for bundle in bundles:
            target = link_target(deps.get(bundle))
            if target is not None and not os.path.isdir(target):
                unresolved.append(bundle)
        found.append((pdir, mpath, stale, None, unresolved, manifest))
    return found


def package_link_paths(home, profile_dir, pkg):
    """某个包名对应的 node_modules 链接位置（profile 私有层 + 共享挂载层）。"""
    parts = pkg.split("/")
    return [
        os.path.join(profile_dir, "node_modules", *parts),
        os.path.join(home, "profiles", "node_modules", *parts),
    ]


def count_shared_dangling(home):
    """
    只统计、绝不删除：profiles/node_modules 是 DSH 自己的挂载层。

    里面可能有指向历史安装路径的链接（例如 App 改名前是 `/Applications/DSH Desktop.app`）。
    它们无害：`packageDirFromAnchor` 用 createRequire().resolve.paths() 逐个候选目录探测
    `package.json` 是否存在，探测不到的候选会被跳过，继续找下一个（最终落在 DSH 安装包内）。
    """
    root = os.path.join(home, "profiles", "node_modules")
    count = 0
    if not os.path.isdir(root):
        return 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for entry in list(dirnames) + list(filenames):
            path = os.path.join(dirpath, entry)
            if os.path.islink(path) and not os.path.exists(path):
                count += 1
    return count


def find_cordis_rows(cordis_path, packages):
    """在 materialized cordis.yml 里定位这些包名所在的顶层列表项，返回 [(start, end, 包名)]（行号，含头不含尾）。"""
    if not os.path.isfile(cordis_path) or not packages:
        return []
    with open(cordis_path, encoding="utf-8") as fh:
        lines = fh.readlines()
    hits = []
    for idx, line in enumerate(lines):
        m = re.match(r"^(\s*)name:\s*['\"]?([^'\"\s]+)['\"]?\s*$", line)
        if not m or m.group(2) not in packages:
            continue
        name_indent = len(m.group(1))
        start = None
        for back in range(idx - 1, -1, -1):
            item = re.match(r"^(\s*)- ", lines[back])
            if item and len(item.group(1)) < name_indent:
                start = back
                break
        if start is None or len(re.match(r"^(\s*)", lines[start]).group(1)) != 0:
            continue  # 只处理顶层列表项，嵌套结构交给人工
        end = len(lines)
        for fwd in range(start + 1, len(lines)):
            if re.match(r"^- ", lines[fwd]):
                end = fwd
                break
        hits.append((start, end, m.group(2)))
    return hits


def clean_cordis(cordis_path, packages, apply):
    hits = find_cordis_rows(cordis_path, packages)
    if not hits:
        return 0
    with open(cordis_path, encoding="utf-8") as fh:
        lines = fh.readlines()
    for start, end, pkg in sorted(hits, reverse=True):
        print(f"      · cordis.yml 第 {start + 1}-{end} 行 ← {pkg}")
        if apply:
            del lines[start:end]
    if apply:
        backup(cordis_path)
        with open(cordis_path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
    return len(hits)


def main():
    ap = argparse.ArgumentParser(description="清理悬空的插件安装引用（默认 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只报告）")
    ap.add_argument("--dsh-home", default=None, help="DSH_HOME，默认 $DSH_HOME 或 ~/.dsh")
    args = ap.parse_args()

    home = dsh_home_from(args.dsh_home)
    print("=" * 66)
    print(f" DSH_HOME : {home}")
    print(f" 模式     : {'APPLY（会写入，写入前备份）' if args.apply else 'DRY-RUN（只报告）'}")
    print("=" * 66)
    if not os.path.isdir(home):
        print(f"❌ 找不到 DSH_HOME：{home}")
        return 1

    problems = 0
    stale_all = {}  # 包名 -> [profile 目录, ...]

    # 1) profile manifest 里的悬空 link: 依赖 + 该依赖专属的 node_modules 链接
    for pdir, mpath, stale, err, unresolved, manifest in scan_manifests(home):
        print(f"\n[profile] {pdir}")
        if err:
            print(f"   ⚠️ {err}")
            problems += 1
            continue
        if not stale:
            print("   ✅ dependencies 里的本地路径依赖都还在")
        for pkg, target in stale:
            problems += 1
            stale_all.setdefault(pkg, []).append(pdir)
            print(f"   ✗ 悬空依赖：{pkg}\n       目标已不存在 → {target}")
            # 该依赖占用的链接位置（共享挂载层只报告，不删）
            for pos, path in enumerate(package_link_paths(home, pdir, pkg)):
                shared = pos == 1
                if not os.path.islink(path):
                    continue
                if os.path.exists(path):
                    continue
                if shared:
                    print(f"       · 共享挂载层另有悬空链接（不处理，DSH 会跳过）：{path}")
                else:
                    print(f"       · 删除 profile 私有层悬空链接：{path}")
                    if args.apply:
                        os.unlink(path)
        if stale and args.apply:
            deps = manifest.get("dependencies") or {}
            prof = (manifest.get("dsh") or {}).get("profile") or {}
            bundles = prof.get("bundles") or []
            for pkg, _ in stale:
                deps.pop(pkg, None)
                if pkg in bundles:
                    bundles.remove(pkg)
                    print(f"       · 同时从 dsh.profile.bundles 移除 {pkg}")
            backup(mpath)
            with open(mpath, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            print(f"       · 已写入 {os.path.basename(mpath)}（备份 .bak-{STAMP}）")
        if unresolved:
            for bundle in unresolved:
                if args.apply and bundle in [name for name, _ in stale]:
                    continue  # 本次已随悬空依赖一起从 bundles 移除
                problems += 1
                print(f"   ✗ dsh.profile.bundles 里的 {bundle} 已解析不到")

    # 2) 共享挂载层：只统计，不删（DSH 自己按候选目录逐个探测，悬空项会被跳过）
    shared_dangling = count_shared_dangling(home)
    print(f"\n[共享挂载层] profiles/node_modules 下的悬空链接：{shared_dangling} 个（信息项，不处理）")
    print("   → 这些通常是 App 改名/移动后留下的历史链接，DSH 解析时会跳过，无害。")

    # 3) materialized cordis.yml 里的残留行
    stale_pkgs = set(stale_all)
    print(f"\n[cordis.yml] 残留行检查（这些包已悬空：{sorted(stale_pkgs) or '无'}）")
    cordis_hits = 0
    for name in sorted(os.listdir(os.path.join(home, "profiles"))):
        cordis = os.path.join(home, "profiles", name, "cordis.yml")
        if not os.path.isfile(cordis):
            continue
        hits = find_cordis_rows(cordis, stale_pkgs)
        if hits:
            print(f"   {cordis}")
            cordis_hits += clean_cordis(cordis, stale_pkgs, args.apply)
    if cordis_hits == 0:
        print("   ✅ 没有残留行")
    else:
        problems += cordis_hits

    # 4) 只报告、不自动改的：锁文件
    for name in sorted(os.listdir(os.path.join(home, "profiles"))):
        lock = os.path.join(home, "profiles", name, "pnpm-lock.yaml")
        if not os.path.isfile(lock):
            continue
        try:
            with open(lock, encoding="utf-8") as fh:
                text = fh.read()
        except Exception:
            continue
        for pkg in sorted(stale_pkgs):
            if pkg in text:
                print(f"\n[lockfile] {lock} 仍含 {pkg} 的 link 规格（未改动）")
                print("   → 下次在 Plugins 页面做任何增删，或让 DSH 完成一次组合刷新，即会重写；")
                print("     若 pnpm 因此报错，删除该 profile 的 node_modules/.pnpm/lock.yaml 后再启动。")

    print("\n" + "=" * 66)
    if problems == 0:
        print(" ✅ 没有发现悬空安装引用，无需处理。")
    elif args.apply:
        print(f" ✅ 已处理 {problems} 处问题。请重启 DeepSeek Harness 验证。")
        print(f"    如需回滚：把各 *.bak-{STAMP} 覆盖回原文件即可。")
    else:
        print(f" ⚠️ 发现 {problems} 处问题（本次只报告，未改动）。")
        print("    确认无误后加 --apply 执行清理。")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
