import unittest
from release_policy import (canonical_origin, validate_approval, release_inputs, check_version, unique_object,
                            ReleaseGateError, N14_SIGNER_SHA256, SCHEMA, TICKET)
from pathlib import Path

# Pure strings/records for validator tests; not an endpoint, approval or build input.
GOOD = "https://" + "n15-opaque-python-assertion-4750" + ".com"
OTHER = "https://" + "n15-other-python-assertion-4750" + ".com"


class GateTests(unittest.TestCase):
    def document(self, **updates):
        v = {"schema":SCHEMA,"ticket":TICKET,"approvedOrigin":GOOD,
             "releaseApproved":True,"deploymentVerified":True,"tlsVerified":True,
             "controllerApprovalRef":"unit-validation-only","deploymentEvidenceRef":"unit-validation-only",
             "maxInstalledVersionCode":1,"signerCertificateSha256":N14_SIGNER_SHA256}
        v.update(updates)
        return v

    def fails(self, code, fn, *args):
        with self.assertRaises(ReleaseGateError) as c:
            fn(*args)
        self.assertEqual(c.exception.code,code)

    def test_origin_canonical(self):
        self.assertEqual(canonical_origin(GOOD+"/"),GOOD)
        self.assertEqual(canonical_origin(GOOD+":443"),GOOD)
        self.assertEqual(canonical_origin(GOOD+":8443"),GOOD+":8443")

    def test_bad_protocol_path_userinfo_and_multiple(self):
        for value in (None,"",GOOD.replace("https:","http:"),GOOD+"/x",GOOD+"?x",GOOD+"#x",
                      GOOD+" "+OTHER,GOOD+","+OTHER,GOOD+"\n",GOOD.replace("://","://user@"),GOOD+":0443"):
            with self.subTest(value=value):
                self.fails("ORIGIN_NOT_CANONICAL_HTTPS",canonical_origin,value)

    def test_loopback_placeholders_and_reserved(self):
        for label in ("localhost","x.local","127.0.0.1","0x7f000001","example.com","a.example.org",
                      "demo.cc","example.invalid","abc.test","foo.internal","test1.onion","abc..biz"):
            with self.subTest(label=label):
                self.fails("ORIGIN_NOT_ALLOWED_DNS",canonical_origin,"https://"+label)

    def test_single_origin_before_approval(self):
        for origins in (None,[],[GOOD,OTHER],[GOOD,GOOD]):
            self.fails("ORIGIN_REQUIRED_EXACTLY_ONE",release_inputs,origins,2,None,None,Path("never-read"))

    def test_unapproved_syntactic_domain(self):
        self.fails("CONTROLLER_APPROVAL_REQUIRED",release_inputs,[GOOD],2,None,None,Path("never-read"))

    def test_declared_deploy_and_tls(self):
        for field in ("releaseApproved","deploymentVerified","tlsVerified"):
            self.fails("APPROVAL_OR_DEPLOYMENT_NOT_READY",validate_approval,
                       self.document(**{field:False}),GOOD,2)

    def test_different_origin_or_certificate(self):
        self.fails("APPROVAL_ORIGIN_MISMATCH",validate_approval,self.document(approvedOrigin=OTHER),GOOD,2)
        self.fails("APPROVAL_N14_SIGNER_MISMATCH",validate_approval,
                   self.document(signerCertificateSha256="5"*64),GOOD,2)

    def test_valid_contract_shape_only(self):
        self.assertEqual(validate_approval(self.document(),GOOD,2),GOOD)

    def test_strictly_increasing_version(self):
        self.fails("VERSION_MUST_INCREASE",check_version,1,1)
        self.fails("VERSION_MUST_INCREASE",validate_approval,
                   self.document(maxInstalledVersionCode=2),GOOD,2)
        self.fails("APPROVAL_INSTALLED_VERSION_INVALID",check_version,2,True)

    def test_dup_key_and_ambiguous_fields(self):
        self.fails("APPROVAL_DUPLICATE_KEY",unique_object,[("origin","A"),("origin","B")])
        self.fails("APPROVAL_FIELDS_MISMATCH",validate_approval,self.document(extra=False),GOOD,2)

    def test_private_url_not_an_evidence_ref(self):
        self.fails("APPROVAL_EVIDENCE_REF_INVALID",validate_approval,
                   self.document(deploymentEvidenceRef=GOOD+"/open/abc"),GOOD,2)


if __name__=="__main__":
    unittest.main()
