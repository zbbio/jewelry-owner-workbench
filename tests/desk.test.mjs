import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewView} from '../album-review.mjs';
import {createPilotAccess} from '../pilot-access.mjs';
test('review is an explanation of saved pairs, not an owner or a changed recognition decision',()=>{
 const a={pendingAssetIds:['a'],receipts:[],analysis:{method:'vision',pairs:[{left:'b',right:'c'}]}};
 assert.equal(reviewView(a).analysis.reviewHint.reason,'no_comparable_pairs');assert.equal(a.analysis.reviewHint,undefined);
 assert.deepEqual(reviewView(a).receipts,[]);assert.deepEqual(reviewView(a),reviewView(a));
 a.analysis.pairs.push({left:'c',right:'a'});assert.equal(reviewView(a).analysis.reviewHint.comparedPairs,1);
 a.analysis.note='comparison_budget';assert.equal(reviewView(a).analysis.reviewHint.reason,'analysis_incomplete');
 a.pendingAssetIds=[];assert.equal(reviewView(a),a);
});
test('device trial requires explicitly scoped store/data and a strong ephemeral login; logout invalidates session',()=>{
 assert.throws(()=>createPilotAccess({WORKBENCH_REQUIRE_LOGIN:'1'}));
 const code=randomBytes(32).toString('hex'),access=createPilotAccess({WORKBENCH_REQUIRE_LOGIN:'1',WORKBENCH_DATA:'test',WORKBENCH_SHOP:'test',WORKBENCH_PILOT_CODE:code});
 assert.equal(access.valid({headers:{}}),false);assert.throws(()=>access.signIn('incorrect'));
 const cookie=access.signIn(code);assert.match(cookie,/HttpOnly/);let req={headers:{cookie:cookie.split(';')[0]}};assert.ok(access.valid(req));
 access.logout(req);assert.equal(access.valid(req),false);
});
