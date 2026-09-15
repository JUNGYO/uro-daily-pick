import sys
import unittest
from datetime import date
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from catalog_policy import automatic_paper, recent_paper

class CatalogPolicyTests(unittest.TestCase):
    def test_boundary_and_unknown_dates(self):
        for value in ('1999-12-31',None,'','invalid','2000-02-30'):
            self.assertFalse(automatic_paper({'pub_date':value}))
        self.assertTrue(automatic_paper({'pub_date':'2000-01-01'}))

    def test_recent_five_calendar_years_inclusive_and_leap_day(self):
        self.assertTrue(recent_paper({'pub_date':'2021-09-15'},date(2026,9,15)))
        self.assertFalse(recent_paper({'pub_date':'2021-09-14'},date(2026,9,15)))
        self.assertTrue(recent_paper({'pub_date':'2019-02-28'},date(2024,2,29)))
