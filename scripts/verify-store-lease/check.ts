/**
 * What one check of the store-lease verification is, and how a result reads against its role.
 *
 *   guarantee  must hold on the current code.
 *   finding    a property the current code violates, recorded as an open finding. It stays red in
 *              spirit: the check reproduces the violation, and a run where it no longer reproduces
 *              fails, so the skill gets updated when the code is fixed (never the other way round).
 *   broken     a variant (model) or a deliberately broken copy of the lease (harness) that must be
 *              caught; a variant that passes means the check is blind.
 *   fixed      a proposed fix modelled in TLA+ that must pass, proving the property is satisfiable.
 */
export type Role = "guarantee" | "finding" | "broken" | "fixed";

/**
 * pass          guarantee, broken or fixed behaved as expected.
 * fail          a guarantee broke, a broken variant went uncaught, or a fixed design does not hold.
 * open-finding  a finding reproduced, as recorded.
 * finding-gone  a recorded finding no longer reproduces: update the skill.
 */
export type Status = "pass" | "fail" | "open-finding" | "finding-gone";

export interface Check {
	readonly id: string;
	readonly role: Role;
	readonly claim: string;
	readonly status: Status;
	/** One line of evidence: states checked, rounds run, the observed outcome. */
	readonly detail: string;
	/** The counterexample, one step per line, in the code's words. */
	readonly trace?: readonly string[];
}

/** Maps what happened (`observed` = the property was violated or the harm reproduced) to a status. */
export function judge(role: Role, violated: boolean): Status {
	switch (role) {
		case "guarantee":
		case "fixed":
			return violated ? "fail" : "pass";
		case "broken":
			return violated ? "pass" : "fail";
		case "finding":
			return violated ? "open-finding" : "finding-gone";
	}
}
