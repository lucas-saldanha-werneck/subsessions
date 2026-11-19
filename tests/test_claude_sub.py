"""Tests for claude-sub. The end-to-end tests drive real tmux with a fake `claude` script."""
import importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "bin", "claude-sub")
loader = importlib.machinery.SourceFileLoader("claude_sub", BIN)
spec = importlib.util.spec_from_loader("claude_sub", loader)
cs = importlib.util.module_from_spec(spec)
loader.exec_module(cs)

FAKE = r"""#!/bin/bash
case "$1" in
  --version) echo "${FAKE_VERSION:-2.1.330} (Claude Code)"; exit 0 ;;
  agents) echo '[]'; exit 0 ;;
esac
echo "ARGS=$*"
echo "CODE_MODE=${CLAUDE_CODE_EXPERIMENTAL_CODE_MODE:-unset} CLAUDECODE=${CLAUDECODE:-unset}"
echo "SUB_NAME=${CLAUDE_SUB_NAME:-unset} SUB_PARENT=${CLAUDE_SUB_PARENT:-unset}"
case "${FAKE_MODE:-on}" in
  confirm)
    echo "  ❯ No, start without it"; echo "    Yes, turn on Code Mode"
    while IFS= read -rsn1 k; do [ -z "$k" ] && break; done ;;
  unavailable)
    echo "⚠ Code Mode (experimental) isn't available · it only works with Opus 5.5, Sonnet 5.5 and later models"
    sleep 300; exit 0 ;;
  trust)
    echo "  ❯ No, exit"; echo "    Yes, I trust this folder"; sleep 300; exit 0 ;;
esac
echo "⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on"
echo "❯ "
sleep 300
"""


class Unit(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(cs.classify("x\n⚠ Code Mode (experimental) is on · resumed")[0], "on")
        self.assertEqual(cs.classify("❯ No\n  Yes, turn on Code Mode")[0], "confirm")
        self.assertEqual(cs.classify("Yes, I trust this folder")[0], "trust")
        st, why = cs.classify("Code Mode (experimental) isn't available · it doesn't work in background jobs   │")
        self.assertEqual(st, "unavailable")
        self.assertIn("background jobs", why)
        self.assertEqual(cs.classify("")[0], "starting")

    def test_parse_version(self):
        self.assertEqual(cs.parse_version("2.1.327 (Claude Code)"), (2, 1, 327))
        self.assertIsNone(cs.parse_version("nothing"))
        self.assertTrue(cs.parse_version("2.1.322") < cs.MIN_CLAUDE <= cs.parse_version("2.1.323"))

    def test_default_name(self):
        self.assertEqual(cs.default_name("/a/My Folder", []), "sub-My-Folder")
        self.assertEqual(cs.default_name("/a/x", ["sub-x"]), "sub-x-2")
        self.assertEqual(cs.default_name("/a/x", ["sub-x", "sub-x-2"]), "sub-x-3")
        self.assertTrue(cs.NAME_RE.match(cs.default_name("/a/çã ~!", [])))

    def test_owner_pid_needs_a_live_session(self):
        cfg = tempfile.mkdtemp()
        os.makedirs(os.path.join(cfg, "sessions"))
        old = dict(os.environ)
        try:
            os.environ.update(CLAUDE_CONFIG_DIR=cfg, CLAUDE_PID="4242")
            self.assertIsNone(cs.owner_pid())   # stale: no session file for 4242
            open(os.path.join(cfg, "sessions", "4242.json"), "w").close()
            self.assertEqual(cs.owner_pid(), 4242)
        finally:
            os.environ.clear()
            os.environ.update(old)
            shutil.rmtree(cfg, ignore_errors=True)

    def test_clean_env(self):
        env = cs.clean_env({"CLAUDECODE": "1", "CLAUDE_AGENT_SDK_X": "1", "PATH": "/bin", "HOME": "/h",
                            "CLAUDE_CODE_MESSAGING_SOCKET": "s", "CLAUDE_SUB_PARENT": "1", "CLAUDE_SUB_NAME": "x"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h"})

    def test_unset_snippet_runs(self):
        env = {"PATH": os.environ.get("PATH", "/bin:/usr/bin"), "CLAUDECODE": "1", "CLAUDE_PREVIEW_Y": "2"}
        out = subprocess.run(["sh", "-c", cs.unset_snippet() + 'echo "[$CLAUDECODE][$CLAUDE_PREVIEW_Y]"'],
                             env=env, capture_output=True, text=True).stdout
        self.assertEqual(out.strip(), "[][]")

    def test_names_rejected(self):
        for bad in ["", "-x", "a b", "a/b", "x" * 65, "a;b"]:
            self.assertFalse(cs.NAME_RE.match(bad), bad)


@unittest.skipUnless(shutil.which("tmux"), "tmux not installed")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.mkdir(self.bin)
        with open(os.path.join(self.bin, "claude"), "w") as f:
            f.write(FAKE)
        os.chmod(os.path.join(self.bin, "claude"), 0o755)
        self.folder = os.path.join(self.tmp, "proj")
        os.mkdir(self.folder)
        self.sock = f"claude-sub-test-{os.getpid()}-{int(time.time() * 1000) % 100000}"
        # A config folder of the test's own: no session file, so no parent unless a test adds one.
        self.cfg = os.path.join(self.tmp, "cfg")
        os.makedirs(os.path.join(self.cfg, "sessions"))
        self.env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"],
                        CLAUDE_SUB_SOCKET=self.sock, CLAUDE_SUB_TIMEOUT="15", CLAUDECODE="1",
                        CLAUDE_CONFIG_DIR=self.cfg)
        self.env.pop("CLAUDE_PID", None)

    def tearDown(self):
        subprocess.run(["tmux", "-L", self.sock, "kill-server"], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args, **extra):
        env = dict(self.env, **extra)
        return subprocess.run([sys.executable, BIN, *args], env=env, capture_output=True, text=True, timeout=60)

    def screen(self, name):
        return self.run_cli("screen", name).stdout

    def test_start_list_stop(self):
        r = self.run_cli("start", self.folder, "--model", "sonnet")
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertEqual(info["name"], "sub-proj")
        self.assertEqual(info["codeMode"], "on")
        scr = self.screen("sub-proj")
        self.assertIn("CODE_MODE=1 CLAUDECODE=unset", scr)   # Code Mode set, parent session vars removed
        self.assertIn("ARGS=--name sub-proj --model sonnet", scr)
        # Started outside any session (no CLAUDE_PID, no session file above): a name, no parent.
        self.assertIn("SUB_NAME=sub-proj SUB_PARENT=unset", scr)
        rows = json.loads(self.run_cli("list").stdout)
        self.assertEqual([x["name"] for x in rows], ["sub-proj"])
        r = self.run_cli("stop", "sub-proj")
        self.assertEqual(json.loads(r.stdout), {"stopped": ["sub-proj"], "left": []})

    def test_start_records_the_owner_session(self):
        with open(os.path.join(self.cfg, "sessions", "4242.json"), "w") as f:
            f.write("{}")
        r = self.run_cli("start", self.folder, "--name", "owned", CLAUDE_PID="4242")
        self.assertEqual(r.returncode, 0, r.stderr)
        o = subprocess.run(["tmux", "-L", self.sock, "show-options", "-v", "-t", "=owned:", "@parent"],
                           capture_output=True, text=True)
        self.assertEqual(o.stdout.strip(), "4242")
        # The band's format reads it back per pane.
        o = subprocess.run(["tmux", "-L", self.sock, "list-panes", "-a", "-F", "#{session_name} #{@parent}"],
                           capture_output=True, text=True)
        self.assertIn("owned 4242", o.stdout)
        # The subsession's own process knows its name and the session that started it.
        self.assertIn("SUB_NAME=owned SUB_PARENT=4242", self.screen("owned"))

    def test_limit_and_duplicate(self):
        self.assertEqual(self.run_cli("start", self.folder, "--name", "a").returncode, 0)
        r = self.run_cli("start", self.folder, "--name", "a", CLAUDE_SUB_MAX="3")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("already runs", r.stderr)
        r = self.run_cli("start", self.folder, "--name", "b", CLAUDE_SUB_MAX="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("limit is 1", r.stderr)

    def test_confirm_needs_yes(self):
        r = self.run_cli("start", self.folder, FAKE_MODE="confirm")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--yes", r.stderr)
        self.assertEqual(json.loads(self.run_cli("list").stdout), [])   # cleaned up

    def test_confirm_with_yes(self):
        r = self.run_cli("start", self.folder, "--yes", FAKE_MODE="confirm")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("is on", self.screen("sub-proj"))

    def test_unavailable_and_trust(self):
        r = self.run_cli("start", self.folder, FAKE_MODE="unavailable")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Opus 5.5", r.stderr)
        r = self.run_cli("start", self.folder, FAKE_MODE="trust")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("trust", r.stderr)
        self.assertEqual(json.loads(self.run_cli("list").stdout), [])

    def test_old_version(self):
        r = self.run_cli("start", self.folder, FAKE_VERSION="2.1.300")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("claude update", r.stderr)

    def test_missing_folder_and_unknown_name(self):
        self.assertIn("folder not found", self.run_cli("start", os.path.join(self.tmp, "nope")).stderr)
        self.assertIn("no subsession", self.run_cli("stop", "ghost").stderr)
        self.assertIn("no subsession", self.run_cli("screen", "ghost").stderr)


if __name__ == "__main__":
    unittest.main()
