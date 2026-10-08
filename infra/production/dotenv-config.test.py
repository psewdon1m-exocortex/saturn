import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).with_name("dotenv-config.py")
spec = importlib.util.spec_from_file_location("dotenv_config", HELPER)
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)

class ConfigTests(unittest.TestCase):
    def test_multiline_opaque_key_is_never_treated_as_machine_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config"
            value = ' x\nVAULT_APP_IMAGE=evil\nKERNEL_URL=https://evil.test\n$(never-execute) `literal` "quoted" #literal \n '
            target.write_text("OWNER_ACCESS_KEY='" + value + "'\nVAULT_APP_IMAGE=verified\nKERNEL_URL=https://kernel.test\nOBSOLETE=x\n", encoding="utf-8")
            def run(action, key, *values):
                return subprocess.check_output(["python3", str(HELPER), str(target), action, key, *values], text=True)
            self.assertEqual(run("get", "VAULT_APP_IMAGE"), "verified")
            self.assertEqual(run("get", "KERNEL_URL"), "https://kernel.test")
            run("set", "VAULT_APP_IMAGE", "next-verified")
            run("remove", "OBSOLETE")
            run("set", "NEW_FIELD", "new")
            self.assertEqual(run("get", "OWNER_ACCESS_KEY"), value)
            self.assertEqual(run("get", "VAULT_APP_IMAGE"), "next-verified")
            self.assertEqual(dict((match[1],item) for match,item in config.entries(target.read_text()))["OWNER_ACCESS_KEY"], value)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)

    def test_double_quoted_escapes_empty_and_duplicate_machine_values(self):
        values = dict((match[1], value) for match,value in config.entries('EMPTY=\nKEY=" x\\n\\r "\nIMAGE=old\nIMAGE=new\n'))
        self.assertEqual(values, {"EMPTY":"", "KEY":" x\n\r ", "IMAGE":"new"})

if __name__ == "__main__":
    unittest.main()
