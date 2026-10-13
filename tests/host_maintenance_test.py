import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('maintenance',Path(__file__).parents[1]/'scripts/host-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MaintenanceSafety(unittest.TestCase):
    def fixture(self, flags, restore_fail=False):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root=Path(folder.name)
        for i in range(12):
            p=root/('pre-old-%02d'%i);p.mkdir();(p/'database.dump').write_bytes(b'test')
            os.utime(p,(time.time()-40*86400,time.time()-40*86400))
        called=[]; snapshots=[]
        def run(args,data=None):
            called.append(args)
            if args[:3]==['docker','image','ls']:
                return '\n'.join(json.dumps({'Repository':'relay-station','Tag':'v%d'%i,'ID':'id%d'%i}) for i in range(4))
            if args[:3]==['docker','ps','-aq']:return 'container'
            if args[:2]==['docker','inspect']:return 'sha256:id3'
            if args[:3]==['docker','image','inspect']:return '2020-01-01T00:00:00Z' if args[4]=='{{.Created}}' else 'sha256:'+args[-1]
            if args[:3]==['docker','buildx','inspect']:raise subprocess.CalledProcessError(1,args)
            return ''
        def pg(args,data=None):
            if args[0]=='pg_restore' and '-d' in args and restore_fail:raise subprocess.CalledProcessError(1,args)
            if args[0]=='psql' and data:snapshots.append(data.decode())
            return ''
        def dump(args,**kwargs):kwargs['stdout'].write(b'complete mock dump')
        with patch.object(m,'BACKUPS',root),patch.object(m,'run',run),patch.object(m,'pg',pg),patch.object(m.subprocess,'run',dump),patch.object(m.shutil,'disk_usage',return_value=type('Disk',(),{'free':10*1024**3,'used':20*1024**3,'total':30*1024**3})()),patch.object(sys,'argv',['maintenance']+flags),patch('builtins.print'):
            m.main()
        return root,called,snapshots
    def test_apply_without_restore_never_deletes(self):
        root,calls,snapshots=self.fixture(['--apply'])
        self.assertEqual(len(list(root.glob('pre-*'))),12)
        self.assertFalse(any(c[:3]==['docker','image','rm'] for c in calls))
        self.assertIn('"backupVerified":false',snapshots[0])
    def test_failed_restore_disables_cleanup_and_records_failure(self):
        root,calls,snapshots=self.fixture(['--apply','--verify-backup'],True)
        self.assertEqual(len(list(root.glob('pre-*'))),13)
        self.assertFalse(any(c[:3]==['docker','image','rm'] for c in calls))
        self.assertIn('"backupError":true',snapshots[0])
    def test_verified_dry_run_does_not_delete(self):
        root,calls,snapshots=self.fixture(['--verify-backup'])
        self.assertEqual(len(list(root.glob('pre-*'))),13)
        self.assertFalse(any(c[:3]==['docker','image','rm'] for c in calls))
        self.assertIn('"backupVerified":true',snapshots[0])
    def test_verified_apply_retains_recent_sets_and_all_used_images(self):
        root,calls,snapshots=self.fixture(['--apply','--verify-backup'])
        self.assertEqual(len(list(root.glob('pre-*'))),11)
        self.assertFalse(any(c[:3]==['docker','image','rm'] for c in calls))
        self.assertFalse(any('prune' in c and 'relay-station-cache' not in c for c in calls))

if __name__=='__main__':unittest.main()
