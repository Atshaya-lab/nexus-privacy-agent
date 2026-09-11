import type {
  DomNode,
  UserProfile,
  PlanAction,
  PlanResponse,
  BlockedActionItem,
  MissingFieldItem,
} from '@/types';
import { classifyDomNode } from './classifier';

/**
 * Detects if a natural language task is requesting form filling or autofill
 * using the user's stored profile details.
 */
export function isAutofillIntent(task: string): boolean {
  if (!task) return false;
  const norm = task.toLowerCase().trim();

  // 1. Direct keywords
  if (
    norm.includes('autofill') ||
    norm.includes('auto-fill') ||
    norm.includes('auto fill') ||
    norm.includes('saved detail') ||
    norm.includes('my detail') ||
    norm.includes('my info')
  ) {
    return true;
  }

  // 2. Action verbs + target words (e.g. "fill all details", "fill the form", "fill student registration form")
  const fillVerbs = ['fill', 'populate', 'enter', 'type', 'input', 'complete', 'insert', 'provide', 'put'];
  const formTargets = [
    'detail',
    'details',
    'form',
    'info',
    'information',
    'profile',
    'registration',
    'application',
    'data',
    'fields',
    'all',
    'everything',
  ];

  const hasFillVerb = fillVerbs.some((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(norm));
  const hasFormTarget = formTargets.some((target) => new RegExp(`\\b${target}\\b`, 'i').test(norm));

  if (hasFillVerb && hasFormTarget) {
    return true;
  }

  // 3. Field-specific fill requests (e.g. "fill my email", "fill my name", "fill phone")
  const fieldTargets = [
    'name',
    'first name',
    'last name',
    'email',
    'phone',
    'mobile',
    'number',
    'address',
    'dob',
    'date of birth',
    'city',
    'pincode',
    'zip',
    'gender',
    'state',
    'subject',
    'hobby',
  ];
  const hasFieldTarget = fieldTargets.some((field) => new RegExp(`\\b${field}\\b`, 'i').test(norm));

  if (hasFillVerb && hasFieldTarget) {
    return true;
  }

  return false;
}

/**
 * Detects if any fields present on the active webpage are missing from the saved user profile.
 * Allows the agent to open a small interactive popup asking the user for missing details,
 * exactly like a human filling an application.
 */
export function detectMissingFormFields(
  task: string,
  domNodes: DomNode[],
  profile?: UserProfile
): MissingFieldItem[] {
  const norm = task.toLowerCase().trim();
  const missing: MissingFieldItem[] = [];

  const isGeneralFormFill =
    norm.includes('all') ||
    norm.includes('form') ||
    norm.includes('registration') ||
    norm.includes('application') ||
    norm.includes('everything') ||
    norm.includes('autofill') ||
    norm.includes('auto-fill') ||
    norm.includes('details') ||
    norm.includes('detail') ||
    norm.includes('info');

  const wantsField = (key: string): boolean => {
    if (isGeneralFormFill) return true;
    switch (key) {
      case 'email':
        return norm.includes('email') || norm.includes('mail');
      case 'phone':
        return norm.includes('phone') || norm.includes('mobile') || norm.includes('number');
      case 'firstName':
        return norm.includes('first name') || norm.includes('fname') || (norm.includes('name') && !norm.includes('last'));
      case 'lastName':
        return norm.includes('last name') || norm.includes('lname');
      case 'fullName':
        return norm.includes('full name') || (norm.includes('name') && !norm.includes('first') && !norm.includes('last'));
      case 'address':
        return norm.includes('address') || norm.includes('street');
      case 'gender':
        return norm.includes('gender') || norm.includes('sex');
      case 'dateOfBirth':
        return norm.includes('dob') || norm.includes('birth') || norm.includes('date');
      case 'city':
        return norm.includes('city');
      case 'state':
        return norm.includes('state');
      case 'pincode':
        return norm.includes('pincode') || norm.includes('pin') || norm.includes('zip');
      default:
        return false;
    }
  };

  const rawFirst = profile?.firstName?.trim() || (profile?.fullName ? profile.fullName.trim().split(/\s+/)[0] : '');
  const rawLast = profile?.lastName?.trim() || (profile?.fullName ? profile.fullName.trim().split(/\s+/).slice(1).join(' ') : '');

  // 1. Check Last Name
  if (wantsField('lastName') && !rawLast) {
    const lnNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('lastname') ||
        id.includes('last_name') ||
        id === 'lname' ||
        p.includes('last name') ||
        name.includes('lastname') ||
        name.includes('last_name')
      );
    });
    if (lnNode) {
      missing.push({
        key: 'lastName',
        label: 'Last Name',
        placeholder: 'e.g. Sharma, Patel, Kumar',
        type: 'text',
        reason: 'The form requires Last Name',
      });
    }
  }

  // 2. Check First Name
  if (wantsField('firstName') && !rawFirst) {
    const fnNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('firstname') ||
        id.includes('first_name') ||
        id === 'fname' ||
        p.includes('first name') ||
        name.includes('firstname') ||
        name.includes('first_name')
      );
    });
    if (fnNode) {
      missing.push({
        key: 'firstName',
        label: 'First Name',
        placeholder: 'e.g. Akshaya',
        type: 'text',
        reason: 'The form requires First Name',
      });
    }
  }

  // 3. Check Email
  if (wantsField('email') && !profile?.email?.trim()) {
    const emNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return ty === 'email' || id.includes('email') || id.includes('mail') || p.includes('email') || name.includes('email');
    });
    if (emNode) {
      missing.push({
        key: 'email',
        label: 'Email Address',
        placeholder: 'e.g. yourname@example.com',
        type: 'email',
        reason: 'The form requires Email',
      });
    }
  }

  // 4. Check Mobile / Phone
  if (wantsField('phone') && !profile?.phone?.trim()) {
    const phoneNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return ty === 'tel' || id.includes('usernumber') || id.includes('mobile') || id.includes('phone') || p.includes('mobile');
    });
    if (phoneNode) {
      missing.push({
        key: 'phone',
        label: 'Mobile Number',
        placeholder: 'e.g. 9876543210',
        type: 'tel',
        reason: 'The form requires Mobile Number',
      });
    }
  }

  // 5. Check Date of Birth
  if (wantsField('dateOfBirth') && !profile?.dateOfBirth?.trim()) {
    const dobNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return ty === 'date' || id.includes('dateofbirth') || id.includes('dob') || p.includes('dob') || p.includes('birth');
    });
    if (dobNode) {
      missing.push({
        key: 'dateOfBirth',
        label: 'Date of Birth',
        placeholder: 'e.g. 15 Jan 2000',
        type: 'text',
        reason: 'The form requires Date of Birth',
      });
    }
  }

  // 6. Check Gender
  if (wantsField('gender') && !profile?.gender?.trim()) {
    const hasGender = domNodes.some((n) => {
      const txt = (n.text || '').toLowerCase();
      const forAttr = (n.attributes?.for || '').toLowerCase();
      const id = (n.attributes?.id || '').toLowerCase();
      return forAttr.includes('gender') || id.includes('gender') || ((txt === 'male' || txt === 'female') && n.tag === 'label');
    });
    if (hasGender) {
      missing.push({
        key: 'gender',
        label: 'Gender',
        placeholder: 'Select Gender',
        type: 'select',
        options: ['Female', 'Male', 'Other'],
        reason: 'The form requires Gender',
      });
    }
  }

  // 7. Check Address
  if (wantsField('address') && !profile?.address?.trim()) {
    const addrNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return id.includes('currentaddress') || id.includes('address') || id.includes('street') || p.includes('address') || name.includes('address');
    });
    if (addrNode) {
      missing.push({
        key: 'address',
        label: 'Current Address',
        placeholder: 'e.g. 42 MG Road',
        type: 'text',
        reason: 'The form requires Address',
      });
    }
  }

  // 8. Check State
  if (wantsField('state') && !profile?.state?.trim()) {
    const stateNode = domNodes.find((n) => {
      if (n.tag === 'label') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return id === 'state' || (id.includes('state') && !id.includes('city') && (n.tag === 'div' || n.tag === 'select'));
    });
    if (stateNode) {
      missing.push({
        key: 'state',
        label: 'State',
        placeholder: 'e.g. NCR, Tamil Nadu, Maharashtra',
        type: 'text',
        reason: 'The form requires State',
      });
    }
  }

  // 9. Check City
  if (wantsField('city') && !profile?.city?.trim()) {
    const cityNode = domNodes.find((n) => {
      if (n.tag === 'label') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return id === 'city' || (id.includes('city') && !id.includes('state') && (n.tag === 'div' || n.tag === 'select'));
    });
    if (cityNode) {
      missing.push({
        key: 'city',
        label: 'City',
        placeholder: 'e.g. Delhi, Chennai, Bangalore',
        type: 'text',
        reason: 'The form requires City',
      });
    }
  }

  return missing;
}

/**
 * Formats date string intelligently: converts YYYY-MM-DD to 'DD Mon YYYY' (e.g. '15 Jan 2000')
 * for text-based datepickers like React Datepicker on DemoQA.
 */
function formatDateForTarget(rawDate: string, isTextInput: boolean): string {
  if (!rawDate) return isTextInput ? '15 Jan 2000' : '2000-01-15';
  const trimmed = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (isTextInput) {
      const parts = trimmed.split('-');
      const y = parts[0] || '2000';
      const m = parseInt(parts[1] || '1', 10);
      const d = parseInt(parts[2] || '15', 10);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mon = months[m - 1] || 'Jan';
      return `${d} ${mon} ${y}`;
    }
    return trimmed;
  }
  return trimmed;
}

/**
 * Generates an autonomous client-side execution plan mapping saved local profile details
 * to corresponding DOM nodes on the active page.
 */
export function generateAutofillPlan(
  task: string,
  domNodes: DomNode[],
  profile?: UserProfile
): PlanResponse {
  const norm = task.toLowerCase().trim();
  const actions: PlanAction[] = [];
  const blockedActions: BlockedActionItem[] = [];

  // 1. Establish effective user profile from strictly saved user profile - NEVER guess or invent fake names!
  const rawFirst = profile?.firstName?.trim() || (profile?.fullName ? profile.fullName.trim().split(/\s+/)[0] : '');
  const rawLast = profile?.lastName?.trim() || (profile?.fullName ? profile.fullName.trim().split(/\s+/).slice(1).join(' ') : '');
  const rawFull = profile?.fullName?.trim() || `${rawFirst} ${rawLast}`.trim();

  const effectiveProfile: UserProfile = {
    fullName: rawFull,
    firstName: rawFirst,
    lastName: rawLast,
    email: profile?.email?.trim() || '',
    phone: profile?.phone?.trim() || '',
    gender: profile?.gender?.trim() || '',
    dateOfBirth: profile?.dateOfBirth?.trim() || '',
    address: profile?.address?.trim() || '',
    city: profile?.city?.trim() || '',
    state: profile?.state?.trim() || '',
    pincode: profile?.pincode?.trim() || '',
    country: profile?.country?.trim() || '',
    jobTitle: profile?.jobTitle?.trim() || '',
    college: profile?.college?.trim() || '',
    experience: profile?.experience?.trim() || '',
    education: profile?.education?.trim() || '',
    linkedin: profile?.linkedin?.trim() || '',
    portfolio: profile?.portfolio?.trim() || '',
  };

  // 2. Identify if the task targets a single field or all form fields
  const isGeneralFormFill =
    norm.includes('all') ||
    norm.includes('form') ||
    norm.includes('registration') ||
    norm.includes('application') ||
    norm.includes('everything') ||
    norm.includes('autofill') ||
    norm.includes('auto-fill') ||
    norm.includes('details') ||
    norm.includes('detail') ||
    norm.includes('info');

  const wantsField = (key: string): boolean => {
    if (isGeneralFormFill) return true;
    switch (key) {
      case 'email':
        return norm.includes('email') || norm.includes('mail');
      case 'phone':
        return norm.includes('phone') || norm.includes('mobile') || norm.includes('number');
      case 'firstName':
        return norm.includes('first name') || norm.includes('fname') || (norm.includes('name') && !norm.includes('last'));
      case 'lastName':
        return norm.includes('last name') || norm.includes('lname');
      case 'fullName':
        return norm.includes('full name') || (norm.includes('name') && !norm.includes('first') && !norm.includes('last'));
      case 'address':
        return norm.includes('address') || norm.includes('street');
      case 'gender':
        return norm.includes('gender') || norm.includes('sex');
      case 'dateOfBirth':
        return norm.includes('dob') || norm.includes('birth') || norm.includes('date');
      case 'city':
        return norm.includes('city');
      case 'state':
        return norm.includes('state');
      case 'pincode':
        return norm.includes('pincode') || norm.includes('pin') || norm.includes('zip');
      case 'subjects':
        return norm.includes('subject');
      case 'hobbies':
        return norm.includes('hobb');
      default:
        return false;
    }
  };

  // 3. Helpers
  const usedNodeIds = new Set<string>();

  const getNodeId = (node: DomNode): string => {
    return (
      node.attributes?.['data-nexus-dom-id'] ||
      node.attributes?.id ||
      `${node.tag}_${node.boundingBox?.x}_${node.boundingBox?.y}`
    );
  };

  const getSelector = (node: DomNode): string => {
    if (node.attributes?.id) return `#${node.attributes.id}`;
    if (node.attributes?.name) return `${node.tag}[name="${node.attributes.name}"]`;
    return node.tag;
  };

  const getBbox = (node?: DomNode) => ({
    x: node?.boundingBox?.x || 0,
    y: node?.boundingBox?.y || 0,
    w: node?.boundingBox?.width || 80,
    h: node?.boundingBox?.height || 32,
  });

  // 4. Map Fields Sequentially

  // 1) First Name
  if (wantsField('firstName')) {
    const fnNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'firstName') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('firstname') ||
        id.includes('first_name') ||
        id === 'fname' ||
        p.includes('first name') ||
        name.includes('firstname') ||
        name.includes('first_name')
      );
    });

    if (fnNode && effectiveProfile.firstName) {
      usedNodeIds.add(getNodeId(fnNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(fnNode),
        groundedBbox: getBbox(fnNode),
        value: effectiveProfile.firstName,
        confidence: 0.96,
        reasoning: `Autofill First Name with "${effectiveProfile.firstName}" from saved profile`,
      });
    }
  }

  // 2) Last Name
  if (wantsField('lastName')) {
    const lnNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'lastName') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('lastname') ||
        id.includes('last_name') ||
        id === 'lname' ||
        p.includes('last name') ||
        name.includes('lastname') ||
        name.includes('last_name')
      );
    });

    if (lnNode && effectiveProfile.lastName) {
      usedNodeIds.add(getNodeId(lnNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(lnNode),
        groundedBbox: getBbox(lnNode),
        value: effectiveProfile.lastName,
        confidence: 0.96,
        reasoning: `Autofill Last Name with "${effectiveProfile.lastName}" from saved profile`,
      });
    }
  }

  // 3) Full Name (single input fallback)
  if (wantsField('fullName')) {
    const singleNameNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'fullName') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('fullname') ||
        id.includes('full_name') ||
        p.includes('full name') ||
        name.includes('fullname') ||
        id === 'name' ||
        name === 'name'
      );
    });

    if (singleNameNode && effectiveProfile.fullName) {
      usedNodeIds.add(getNodeId(singleNameNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(singleNameNode),
        groundedBbox: getBbox(singleNameNode),
        value: effectiveProfile.fullName,
        confidence: 0.95,
        reasoning: `Autofill Full Name with "${effectiveProfile.fullName}" from saved profile`,
      });
    }
  }

  // 4) Email
  if (wantsField('email')) {
    const emailNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'email') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return (
        ty === 'email' ||
        id.includes('email') ||
        id.includes('mail') ||
        p.includes('email') ||
        p.includes('@') ||
        name.includes('email')
      );
    });

    if (emailNode && effectiveProfile.email) {
      usedNodeIds.add(getNodeId(emailNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(emailNode),
        groundedBbox: getBbox(emailNode),
        value: effectiveProfile.email,
        confidence: 0.98,
        reasoning: `Autofill Email with "${effectiveProfile.email}" from saved profile`,
      });
    }
  }

  // 5) Gender
  if (wantsField('gender') && effectiveProfile.gender) {
    const userGender = effectiveProfile.gender.toLowerCase().trim();

    // Look for matching <label for="gender-radio-X"> (standard for Bootstrap/Tailwind custom radios like DemoQA)
    const genderLabel = domNodes.find((n) => {
      if (n.tag !== 'label') return false;
      const txt = (n.text || '').toLowerCase().trim();
      const forAttr = (n.attributes?.for || '').toLowerCase();
      return (
        txt === userGender ||
        (forAttr.includes('gender') && (txt.includes(userGender) || forAttr.includes(userGender)))
      );
    });

    if (genderLabel) {
      usedNodeIds.add(getNodeId(genderLabel));
      const targetSel = genderLabel.attributes?.for
        ? `label[for="${genderLabel.attributes.for}"]`
        : (genderLabel.attributes?.id ? `#${genderLabel.attributes.id}` : 'label');
      actions.push({
        action: 'click',
        targetSelector: targetSel,
        groundedBbox: getBbox(genderLabel),
        confidence: 0.95,
        reasoning: `Select Gender "${effectiveProfile.gender}" radio label`,
      });
    } else {
      // Direct radio input fallback
      const genderRadio = domNodes.find((n) => {
        if (n.tag !== 'input' || n.attributes?.type !== 'radio') return false;
        const id = (n.attributes?.id || '').toLowerCase();
        const val = (n.attributes?.value || '').toLowerCase();
        const name = (n.attributes?.name || '').toLowerCase();
        const firstChar = userGender.charAt(0);
        return (
          (name.includes('gender') || id.includes('gender')) &&
          (val === userGender || id.includes(userGender) || (firstChar ? val.startsWith(firstChar) : false))
        );
      });

      if (genderRadio) {
        usedNodeIds.add(getNodeId(genderRadio));
        actions.push({
          action: 'click',
          targetSelector: getSelector(genderRadio),
          groundedBbox: getBbox(genderRadio),
          confidence: 0.95,
          reasoning: `Select Gender "${effectiveProfile.gender}" radio input`,
        });
      } else {
        const genderSelect = domNodes.find((n) => {
          if (n.tag !== 'select') return false;
          const id = (n.attributes?.id || '').toLowerCase();
          const name = (n.attributes?.name || '').toLowerCase();
          return id.includes('gender') || name.includes('gender');
        });

        if (genderSelect) {
          usedNodeIds.add(getNodeId(genderSelect));
          actions.push({
            action: 'select',
            targetSelector: getSelector(genderSelect),
            groundedBbox: getBbox(genderSelect),
            value: effectiveProfile.gender,
            confidence: 0.94,
            reasoning: `Select Gender "${effectiveProfile.gender}" from dropdown`,
          });
        }
      }
    }
  }

  // 6) Mobile / Phone
  if (wantsField('phone')) {
    const phoneNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'phone') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return (
        ty === 'tel' ||
        id.includes('usernumber') ||
        id.includes('mobile') ||
        id.includes('phone') ||
        p.includes('mobile') ||
        p.includes('phone') ||
        name.includes('mobile') ||
        name.includes('phone')
      );
    });

    if (phoneNode && effectiveProfile.phone) {
      usedNodeIds.add(getNodeId(phoneNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(phoneNode),
        groundedBbox: getBbox(phoneNode),
        value: effectiveProfile.phone,
        confidence: 0.96,
        reasoning: `Autofill Mobile/Phone with "${effectiveProfile.phone}" from saved profile`,
      });
    }
  }

  // 7) Date of Birth
  if (wantsField('dateOfBirth')) {
    const dobNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'dateOfBirth') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const ty = (n.attributes?.type || '').toLowerCase();
      return (
        ty === 'date' ||
        id.includes('dateofbirth') ||
        id.includes('dob') ||
        id.includes('birth') ||
        p.includes('birth') ||
        p.includes('dob') ||
        name.includes('birth') ||
        name.includes('dob')
      );
    });

    if (dobNode && effectiveProfile.dateOfBirth) {
      usedNodeIds.add(getNodeId(dobNode));
      const isTextInput = dobNode.attributes?.type !== 'date';
      const formattedDob = formatDateForTarget(effectiveProfile.dateOfBirth, isTextInput);
      actions.push({
        action: 'type',
        targetSelector: getSelector(dobNode),
        groundedBbox: getBbox(dobNode),
        value: formattedDob,
        confidence: 0.95,
        reasoning: `Autofill Date of Birth with "${formattedDob}" from saved profile`,
      });
    }
  }

  // 8) Subjects (e.g. #subjectsInput on DemoQA)
  if (wantsField('subjects')) {
    const subjNode = domNodes.find((n) => {
      if (n.tag === 'label') return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id === 'subjectsinput' ||
        id.includes('subjectinput') ||
        (n.tag === 'input' && (id.includes('subject') || p.includes('subject') || name.includes('subject')))
      );
    });

    if (subjNode) {
      usedNodeIds.add(getNodeId(subjNode));
      actions.push({
        action: 'type',
        targetSelector: subjNode.attributes?.id ? `#${subjNode.attributes.id}` : '#subjectsInput',
        groundedBbox: getBbox(subjNode),
        value: 'Maths',
        confidence: 0.92,
        reasoning: `Autofill Subject with "Maths"`,
      });
    }
  }

  // 9) Hobbies (e.g. Sports/Reading checkboxes on DemoQA)
  if (wantsField('hobbies')) {
    const hobbyLabel = domNodes.find((n) => {
      if (n.tag !== 'label') return false;
      const forAttr = (n.attributes?.for || '').toLowerCase();
      const txt = (n.text || '').toLowerCase();
      return (
        forAttr.includes('hobbies') ||
        forAttr.includes('hobby') ||
        txt.includes('sports') ||
        txt.includes('reading')
      );
    });

    if (hobbyLabel) {
      usedNodeIds.add(getNodeId(hobbyLabel));
      const targetSel = hobbyLabel.attributes?.for
        ? `label[for="${hobbyLabel.attributes.for}"]`
        : (hobbyLabel.attributes?.id ? `#${hobbyLabel.attributes.id}` : 'label');
      actions.push({
        action: 'click',
        targetSelector: targetSel,
        groundedBbox: getBbox(hobbyLabel),
        confidence: 0.92,
        reasoning: `Select Hobby checkbox label (${hobbyLabel.text || 'Sports'})`,
      });
    }
  }

  // 10) Current Address
  if (wantsField('address')) {
    const addrNode = domNodes.find((n) => {
      if (n.tag !== 'input' && n.tag !== 'textarea') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'address') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('currentaddress') ||
        id.includes('address') ||
        id.includes('street') ||
        p.includes('address') ||
        name.includes('address')
      );
    });

    if (addrNode && effectiveProfile.address) {
      usedNodeIds.add(getNodeId(addrNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(addrNode),
        groundedBbox: getBbox(addrNode),
        value: effectiveProfile.address,
        confidence: 0.96,
        reasoning: `Autofill Address with "${effectiveProfile.address}" from saved profile`,
      });
    }
  }

  // 11) State (Handles both native <select> and custom dropdowns like DemoQA React-Select)
  if (wantsField('state')) {
    const stateVal = effectiveProfile.state;
    const stateNode = domNodes.find((n) => {
      if (n.tag === 'label') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const role = (n.attributes?.role || '').toLowerCase();
      return (
        id === 'state' ||
        id === 'react-select-3-input' ||
        (n.tag === 'select' && (id.includes('state') || name.includes('state'))) ||
        (id.includes('state') && !id.includes('city') && (n.tag === 'div' || n.tag === 'select' || role === 'combobox'))
      );
    });

    if (stateNode && stateVal) {
      usedNodeIds.add(getNodeId(stateNode));
      const selector = stateNode.attributes?.id ? `#${stateNode.attributes.id}` : getSelector(stateNode);

      actions.push({
        action: 'select',
        targetSelector: selector,
        groundedBbox: getBbox(stateNode),
        value: stateVal,
        confidence: 0.93,
        reasoning: `Autofill State with "${stateVal}" from saved profile`,
      });
    }
  }

  // 12) City (Handles both native <select> and custom dropdowns like DemoQA React-Select)
  if (wantsField('city')) {
    const cityVal = effectiveProfile.city;
    const cityNode = domNodes.find((n) => {
      if (n.tag === 'label') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      const role = (n.attributes?.role || '').toLowerCase();
      return (
        id === 'city' ||
        id === 'react-select-4-input' ||
        (n.tag === 'select' && (id.includes('city') || name.includes('city'))) ||
        (id.includes('city') && !id.includes('state') && (n.tag === 'div' || n.tag === 'select' || role === 'combobox'))
      );
    });

    if (cityNode && cityVal) {
      usedNodeIds.add(getNodeId(cityNode));
      const selector = cityNode.attributes?.id ? `#${cityNode.attributes.id}` : getSelector(cityNode);

      actions.push({
        action: 'select',
        targetSelector: selector,
        groundedBbox: getBbox(cityNode),
        value: cityVal,
        confidence: 0.93,
        reasoning: `Autofill City with "${cityVal}" from saved profile`,
      });
    }
  }

  // 13) Pincode / Zip (if present on form)
  if (wantsField('pincode')) {
    const pinNode = domNodes.find((n) => {
      if (n.tag !== 'input') return false;
      if (usedNodeIds.has(getNodeId(n))) return false;
      const cls = classifyDomNode(n);
      if (cls.dataKey === 'pincode') return true;
      const id = (n.attributes?.id || '').toLowerCase();
      const p = (n.attributes?.placeholder || '').toLowerCase();
      const name = (n.attributes?.name || '').toLowerCase();
      return (
        id.includes('pincode') ||
        id.includes('pin') ||
        id.includes('zip') ||
        p.includes('pin') ||
        p.includes('zip') ||
        name.includes('pin') ||
        name.includes('zip')
      );
    });

    if (pinNode && effectiveProfile.pincode) {
      usedNodeIds.add(getNodeId(pinNode));
      actions.push({
        action: 'type',
        targetSelector: getSelector(pinNode),
        groundedBbox: getBbox(pinNode),
        value: effectiveProfile.pincode,
        confidence: 0.94,
        reasoning: `Autofill Pincode/Zip with "${effectiveProfile.pincode}" from saved profile`,
      });
    }
  }

  // 14) Optional Submit Action (only if explicitly requested by prompt, e.g. "fill and submit")
  if (norm.includes('submit') || norm.includes('send') || (norm.includes('fill') && norm.includes('complete'))) {
    const submitBtn = domNodes.find((n) => {
      const isBtn = n.tag === 'button' || n.attributes?.type === 'submit' || n.role === 'button';
      if (!isBtn) return false;
      const t = (n.text || '').toLowerCase();
      const id = (n.attributes?.id || '').toLowerCase();
      return t.includes('submit') || id.includes('submit') || t.includes('send');
    });

    if (submitBtn) {
      actions.push({
        action: 'click',
        targetSelector: getSelector(submitBtn),
        groundedBbox: getBbox(submitBtn),
        confidence: 0.9,
        reasoning: `Submit form via ${submitBtn.text || 'Submit button'}`,
      });
    }
  }

  return {
    done: true,
    summary: `Autofill Agent mapped ${actions.length} field(s) from Local Vault directly to active form elements.`,
    groundingMode: 'CLIENT_AUTONOMOUS_VAULT',
    actions,
    blockedActions,
    auditTrail: actions.map((a, idx) => ({
      step: `Step ${idx + 1}: ${a.action.toUpperCase()}`,
      status: 'PLANNED',
      mode: 'CLIENT_AUTONOMOUS_VAULT',
      targetSelector: a.targetSelector,
      groundedBbox: a.groundedBbox,
      confidence: a.confidence,
      details: a.reasoning || '',
      timestamp: Date.now(),
    })),
  };
}
